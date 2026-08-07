/**
 * WP6 persistence integration: candidate coalescing and terminal cursor writes.
 * GitLab and credential decryption remain injected; PostgreSQL is real.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import {
  PrismaSyncPersistence,
  type SyncGitLabClient,
  SyncOrchestrator,
} from "./sync-orchestrator.js";

await requirePostgresIntegrationDatabase("Sync orchestrator integration tests");

describe("SyncOrchestrator persistence (PostgreSQL)", () => {
  const prisma: PrismaClient = getPrisma();
  const suffix = randomUUID().replaceAll("-", "");
  const instanceId = `sync_instance_${suffix}`;
  const projectId = `sync_project_${suffix}`;
  const userIds = {
    eligible: `sync_eligible_${suffix}`,
    disabled: `sync_disabled_${suffix}`,
    inactive: `sync_inactive_${suffix}`,
    invalidConnection: `sync_invalid_connection_${suffix}`,
  } as const;

  async function createUser(
    id: string,
    status: "active" | "deactivated" = "active",
  ): Promise<void> {
    await prisma.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        normalizedEmail: `${id}@example.test`,
        passwordHashArgon2id: "integration-only",
        role: "developer",
        status,
      },
    });
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: {
        id: instanceId,
        baseUrlNormalized: `https://gitlab-${suffix}.example.test`,
        internal: false,
      },
    });
    await prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: projectId,
        pathWithNamespace: "team/project",
      },
    });

    for (const [key, userId] of Object.entries(userIds)) {
      await createUser(userId, key === "inactive" ? "deactivated" : "active");
      await prisma.gitLabConnection.create({
        data: {
          id: `connection_${key}_${suffix}`,
          userId,
          gitlabInstanceId: instanceId,
          gitlabUserId: `gitlab_${key}_${suffix}`,
          gitlabUsername: key,
          status: key === "invalidConnection" ? "invalid" : "active",
        },
      });
      if (key !== "disabled") {
        await prisma.userProjectEnable.create({
          data: {
            userId,
            gitlabInstanceId: instanceId,
            gitlabProjectId: projectId,
          },
        });
      }
    }
  });

  after(async () => {
    await prisma.$transaction([
      prisma.commitCache.deleteMany({
        where: { gitlabInstanceId: instanceId, gitlabProjectId: projectId },
      }),
      prisma.mergeRequestCache.deleteMany({
        where: { gitlabInstanceId: instanceId, gitlabProjectId: projectId },
      }),
      prisma.commitSyncState.deleteMany({
        where: { gitlabInstanceId: instanceId, gitlabProjectId: projectId },
      }),
      prisma.mrSyncState.deleteMany({
        where: { gitlabInstanceId: instanceId, gitlabProjectId: projectId },
      }),
      prisma.user.deleteMany({ where: { id: { in: Object.values(userIds) } } }),
    ]);
    await prisma.gitLabInstanceAllowlist.deleteMany({
      where: { id: instanceId },
    });
    await prisma.$disconnect();
  });

  it("uses only an active enabled user's connection and persists caches/cursors", async () => {
    const factoryConnections: string[] = [];
    const runEnd = new Date("2026-08-07T04:00:00.000Z");
    const gitlab: SyncGitLabClient = {
      async getProject() {
        return {
          id: 42,
          pathWithNamespace: "team/project",
          name: "project",
          archived: false,
          defaultBranch: "main",
          webUrl: null,
          lastActivityAt: null,
        };
      },
      async listBranches() {
        return {
          items: [
            {
              name: "main",
              merged: false,
              protected: true,
              default: true,
            },
          ],
          nextPage: null,
        };
      },
      async listCommits() {
        return {
          items: [
            {
              id: `sha_${suffix}`,
              shortId: suffix.slice(0, 8),
              title: "integration commit",
              message: "integration commit",
              authorName: "Dev",
              authorEmail: " DEV@Example.Test ",
              authoredDate: "2026-08-07T03:00:00.000Z",
              webUrl: null,
            },
          ],
          nextPage: null,
        };
      },
      async listMergeRequests() {
        return {
          items: [
            {
              iid: 7,
              projectId: 42,
              title: "integration MR",
              state: "opened",
              authorUsername: "dev",
              authorEmail: " MR@Example.Test ",
              updatedAt: "2026-08-07T03:30:00.000Z",
              webUrl: null,
              sha: `head_${suffix}`,
              reviewers: [],
            },
          ],
          nextPage: null,
        };
      },
    };

    const outcome = await new SyncOrchestrator({
      persistence: new PrismaSyncPersistence(prisma),
      credentials: {
        async getAccessToken() {
          return "integration-token-never-persisted";
        },
        async invalidateCredential() {},
      },
      clientFactory: ({ candidate }) => {
        factoryConnections.push(candidate.connectionId);
        return gitlab;
      },
      now: () => runEnd,
    }).syncProject({
      gitlabInstanceId: instanceId,
      gitlabProjectId: projectId,
    });

    assert.equal(outcome.status, "completed");
    assert.deepEqual(factoryConnections, [`connection_eligible_${suffix}`]);

    const [storedCommit, storedMr, commitState, mrState] = await Promise.all([
      prisma.commitCache.findUnique({
        where: {
          gitlabInstanceId_gitlabProjectId_sha: {
            gitlabInstanceId: instanceId,
            gitlabProjectId: projectId,
            sha: `sha_${suffix}`,
          },
        },
      }),
      prisma.mergeRequestCache.findUnique({
        where: {
          gitlabInstanceId_gitlabProjectId_iid: {
            gitlabInstanceId: instanceId,
            gitlabProjectId: projectId,
            iid: 7,
          },
        },
      }),
      prisma.commitSyncState.findUnique({
        where: {
          gitlabInstanceId_gitlabProjectId: {
            gitlabInstanceId: instanceId,
            gitlabProjectId: projectId,
          },
        },
      }),
      prisma.mrSyncState.findUnique({
        where: {
          gitlabInstanceId_gitlabProjectId: {
            gitlabInstanceId: instanceId,
            gitlabProjectId: projectId,
          },
        },
      }),
    ]);

    assert.equal(storedCommit?.authorEmailNormalized, "dev@example.test");
    assert.equal(storedMr?.authorEmailNormalized, "mr@example.test");
    assert.equal(commitState?.lastBranchCursor, null);
    assert.equal(
      commitState?.watermarkAuthoredAt?.toISOString(),
      runEnd.toISOString(),
    );
    assert.equal(
      mrState?.updatedAfterCursor?.toISOString(),
      runEnd.toISOString(),
    );
  });
});
