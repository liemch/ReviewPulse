/**
 * M2 MR workspace integration — authz-first list/detail with mocked GitLab.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import {
  AesGcmSecretSealer,
  createStaticKeyLoader,
} from "@reviewpulse/crypto";
import { createPatCredentialProvider } from "@reviewpulse/credentials";
import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import {
  GitLabConnectionService,
  type GitLabIdentityProbe,
} from "./gitlab-connection.js";
import { MrMutationService } from "./mr-mutations.js";
import { MrWorkspaceService } from "./mr-workspace.js";
import {
  LiveProjectAccessService,
  type AllowlistedProjectProbe,
  type VisibleProject,
} from "./project-access.js";

await requirePostgresIntegrationDatabase("M2 MR workspace integration tests");

function visibleProject(id: string, path: string): VisibleProject {
  return {
    id: Number(id),
    pathWithNamespace: path,
    name: path.split("/")[1] ?? path,
  };
}

describe("M2 MR workspace authz (PostgreSQL)", () => {
  const prisma: PrismaClient = getPrisma();
  const sealer = new AesGcmSecretSealer(
    createStaticKeyLoader(randomBytes(32).toString("base64"), "v1"),
  );
  const credentials = createPatCredentialProvider({ prisma, sealer });

  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `inst_m2_${suiteId}`;
  const baseUrl = `https://gitlab-m2-${suiteId}.test`;
  const fixtureUserIds = new Set<string>();

  const identities = new Map<string, { id: string; username: string }>();
  const visibility = new Map<string, Map<string, VisibleProject>>();

  const probe: GitLabIdentityProbe = async (input) => {
    const identity = identities.get(input.pat);
    if (!identity) {
      throw new Error("unknown pat");
    }
    return {
      gitlabUserId: identity.id,
      gitlabUsername: identity.username,
      email: null,
      name: identity.username,
    };
  };

  const probeAllowlisted: AllowlistedProjectProbe = async (input) => {
    const all = visibility.get(input.pat) ?? new Map();
    const out = new Map<string, VisibleProject>();
    for (const id of input.projectIds) {
      const ref = all.get(id);
      if (ref) {
        out.set(id, ref);
      }
    }
    return { visible: out, failed: new Map() };
  };

  const connections = new GitLabConnectionService(prisma, credentials, probe);
  const projects = new LiveProjectAccessService(
    prisma,
    credentials,
    probeAllowlisted,
  );

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: {
        id: instanceId,
        baseUrlNormalized: baseUrl,
        internal: false,
      },
    });
    await prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "101",
        pathWithNamespace: "group/a",
      },
    });
    await prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "202",
        pathWithNamespace: "group/b",
      },
    });
  });

  afterEach(async () => {
    const ids = [...fixtureUserIds];
    fixtureUserIds.clear();
    identities.clear();
    visibility.clear();
    if (ids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  after(async () => {
    await prisma.reviewPulseProjectAllowlist.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
    await prisma.gitLabInstanceAllowlist.deleteMany({
      where: { id: instanceId },
    });
  });

  async function createUser(email: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email,
        normalizedEmail: email.toLowerCase(),
        passwordHashArgon2id: "x".repeat(64),
        role: "developer",
        status: "active",
      },
    });
    fixtureUserIds.add(user.id);
    return user.id;
  }

  it("User A cannot see User B project via list or direct detail", async () => {
    const userA = await createUser(`a-${suiteId}@example.test`);
    const userB = await createUser(`b-${suiteId}@example.test`);

    const patA = `pat-a-${suiteId}`;
    const patB = `pat-b-${suiteId}`;
    identities.set(patA, { id: `ga-${suiteId}`, username: "alice" });
    identities.set(patB, { id: `gb-${suiteId}`, username: "bob" });
    visibility.set(patA, new Map([["101", visibleProject("101", "group/a")]]));
    visibility.set(patB, new Map([["202", visibleProject("202", "group/b")]]));

    await connections.saveConnection({
      userId: userA,
      baseUrl,
      pat: patA,
    });
    await connections.saveConnection({
      userId: userB,
      baseUrl,
      pat: patB,
    });

    await projects.enable({
      userId: userA,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "101",
    });
    await projects.enable({
      userId: userB,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "202",
    });

    const workspace = new MrWorkspaceService(prisma, projects, credentials);

    const authorizedA = await projects.authorizedProjectIds(userA);
    assert.deepEqual(
      authorizedA.map((p) => p.gitlabProjectId).sort(),
      ["101"],
    );

    const listA = await workspace.list(userA, {
      gitlabInstanceId: instanceId,
      gitlabProjectId: "202",
    });
    assert.deepEqual(listA, []);

    const detailCross = await workspace.getDetail(userA, {
      gitlabInstanceId: instanceId,
      gitlabProjectId: "202",
      iid: 1,
    });
    assert.deepEqual(detailCross, { kind: "not_found" });

    const audits: Array<Record<string, unknown>> = [];
    const mutations = new MrMutationService(prisma, projects, credentials, {
      async write(action, actorUserId, meta) {
        audits.push({ action, actorUserId, ...meta });
      },
    });

    const commentDenied = await mutations.comment(
      userA,
      {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "202",
        iid: 1,
      },
      "should not post",
    );
    assert.equal(commentDenied.ok, false);
    if (!commentDenied.ok) {
      assert.equal(commentDenied.error, "not_found");
    }
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.["action"], "mr_comment");
    assert.equal(audits[0]?.["result"], "failure");
    assert.equal(audits[0]?.["category"], "not_found");
    assert.equal("pat" in (audits[0] ?? {}), false);
    assert.equal("diff" in (audits[0] ?? {}), false);
  });
});
