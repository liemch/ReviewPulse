import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabUnauthorizedError,
  type GitLabBranchRef,
  type GitLabCommit,
  type GitLabMergeRequest,
  type GitLabPageCursor,
  type GitLabProjectRef,
  type Page,
} from "@reviewpulse/gitlab-client";

import {
  type CommitCacheWrite,
  type CommitSyncState,
  type MergeRequestCacheWrite,
  type MrSyncState,
  type SyncCandidate,
  type SyncGitLabClient,
  type SyncPersistence,
  type SyncProject,
  SyncOrchestrator,
} from "./sync-orchestrator.js";

const PROJECT: SyncProject = {
  gitlabInstanceId: "instance-1",
  gitlabProjectId: "42",
};
const RUN_END = new Date("2026-08-07T04:00:00.000Z");
const NEXT_RUN_END = new Date("2026-08-07T05:00:00.000Z");

function candidate(id: string, userId = `user-${id}`): SyncCandidate {
  return {
    connectionId: id,
    userId,
    instanceId: PROJECT.gitlabInstanceId,
    baseUrlNormalized: "https://gitlab.example.test",
    internal: false,
  };
}

function projectRef(): GitLabProjectRef {
  return {
    id: 42,
    pathWithNamespace: "team/project",
    name: "project",
    archived: false,
    defaultBranch: "main",
    webUrl: "https://gitlab.example.test/team/project",
    lastActivityAt: null,
  };
}

function branch(name: string): GitLabBranchRef {
  return { name, merged: false, protected: false, default: name === "main" };
}

function commit(
  sha: string,
  authoredDate = "2026-08-07T03:00:00.000Z",
  authorEmail: string | null = " Dev@Example.COM ",
): GitLabCommit {
  return {
    id: sha,
    shortId: sha.slice(0, 8),
    title: `commit ${sha}`,
    message: `commit ${sha}`,
    authorName: "Dev",
    authorEmail,
    authoredDate,
    webUrl: `https://gitlab.example.test/commit/${sha}`,
  };
}

function mergeRequest(iid: number, updatedAt: string): GitLabMergeRequest {
  return {
    iid,
    projectId: 42,
    title: `MR ${iid}`,
    state: "opened",
    authorUsername: "dev",
    authorEmail: " MR@Example.COM ",
    updatedAt,
    webUrl: `https://gitlab.example.test/mr/${iid}`,
    sha: `head-${iid}`,
  };
}

type ClientOverrides = Partial<{
  getProject: SyncGitLabClient["getProject"];
  listBranches: SyncGitLabClient["listBranches"];
  listCommits: SyncGitLabClient["listCommits"];
  listMergeRequests: SyncGitLabClient["listMergeRequests"];
}>;

function client(overrides: ClientOverrides = {}): SyncGitLabClient {
  return {
    getProject:
      overrides.getProject ??
      (async () => {
        return projectRef();
      }),
    listBranches:
      overrides.listBranches ??
      (async () => ({ items: [branch("main")], nextPage: null })),
    listCommits:
      overrides.listCommits ??
      (async () => ({ items: [], nextPage: null })),
    listMergeRequests:
      overrides.listMergeRequests ??
      (async () => ({ items: [], nextPage: null })),
  };
}

class MemoryPersistence implements SyncPersistence {
  candidates: SyncCandidate[] = [candidate("connection-1")];
  commitState: CommitSyncState | null = null;
  mrState: MrSyncState | null = null;
  readonly commits = new Map<string, CommitCacheWrite>();
  readonly mergeRequests = new Map<number, MergeRequestCacheWrite>();
  readonly invalidConnections: string[] = [];
  readonly invalidatedMemberships: string[] = [];
  readonly deniedMemberships: string[] = [];
  completedCommitWindows = 0;
  completedMrWindows = 0;

  async findCandidates(): Promise<readonly SyncCandidate[]> {
    return this.candidates;
  }

  async markConnectionInvalid(connectionId: string): Promise<void> {
    this.invalidConnections.push(connectionId);
  }

  async invalidateMembershipUserInstance(
    userId: string,
    instanceId: string,
  ): Promise<void> {
    this.invalidatedMemberships.push(`${userId}:${instanceId}`);
  }

  async denyMembership(
    userId: string,
    project: SyncProject,
  ): Promise<void> {
    this.deniedMemberships.push(
      `${userId}:${project.gitlabInstanceId}:${project.gitlabProjectId}`,
    );
  }

  async getCommitState(): Promise<CommitSyncState | null> {
    return this.commitState;
  }

  async beginCommitWindow(
    _project: SyncProject,
    windowStart: Date,
    windowEnd: Date,
    firstBranchCursor: string | null,
  ): Promise<void> {
    this.commitState = {
      watermarkAuthoredAt: this.commitState?.watermarkAuthoredAt ?? null,
      lastFullWindowStart: new Date(windowStart),
      lastFullWindowEnd: new Date(windowEnd),
      lastBranchCursor: firstBranchCursor,
    };
  }

  async upsertCommit(value: CommitCacheWrite): Promise<void> {
    this.commits.set(value.sha, value);
  }

  async advanceCommitBranch(
    _project: SyncProject,
    nextBranchCursor: string | null,
  ): Promise<void> {
    assert.ok(this.commitState);
    this.commitState = {
      ...this.commitState,
      lastBranchCursor: nextBranchCursor,
    };
  }

  async completeCommitWindow(
    _project: SyncProject,
    watermark: Date,
  ): Promise<void> {
    assert.ok(this.commitState);
    this.completedCommitWindows += 1;
    this.commitState = {
      ...this.commitState,
      watermarkAuthoredAt: new Date(watermark),
      lastBranchCursor: null,
    };
  }

  async getMrState(): Promise<MrSyncState | null> {
    return this.mrState;
  }

  async upsertMergeRequest(value: MergeRequestCacheWrite): Promise<void> {
    this.mergeRequests.set(value.iid, value);
  }

  async completeMrWindow(
    _project: SyncProject,
    updatedAfterCursor: Date,
  ): Promise<void> {
    this.completedMrWindows += 1;
    this.mrState = { updatedAfterCursor: new Date(updatedAfterCursor) };
  }
}

function credentials(tokens: Record<string, string> = {}) {
  const invalidated: string[] = [];
  return {
    invalidated,
    provider: {
      async getAccessToken(connectionId: string) {
        return tokens[connectionId] ?? `pat-for-${connectionId}`;
      },
      async invalidateCredential(connectionId: string) {
        invalidated.push(connectionId);
      },
    },
  };
}

describe("SyncOrchestrator commit windows", () => {
  it("uses epoch initially, then watermark minus overlap with inclusive boundaries", async () => {
    const persistence = new MemoryPersistence();
    const seen: Array<{ since: Date; until: Date }> = [];
    const gitlab = client({
      async listCommits(_projectId, query) {
        seen.push({ since: query.since, until: query.until });
        return {
          items: [
            commit("boundary", query.since.toISOString()),
            commit("at-end", query.until.toISOString()),
          ],
          nextPage: null,
        };
      },
    });
    const creds = credentials();
    const times = [RUN_END, NEXT_RUN_END];

    for (const now of times) {
      await new SyncOrchestrator({
        persistence,
        credentials: creds.provider,
        clientFactory: () => gitlab,
        now: () => now,
        commitLookbackOverlapMs: 15 * 60_000,
      }).syncProject(PROJECT);
    }

    assert.equal(
      seen[0]?.since.toISOString(),
      "1980-01-01T00:00:00.000Z",
    );
    assert.equal(seen[0]?.until.toISOString(), RUN_END.toISOString());
    assert.equal(
      seen[1]?.since.toISOString(),
      new Date(RUN_END.getTime() - 15 * 60_000).toISOString(),
    );
    assert.equal(seen[1]?.until.toISOString(), NEXT_RUN_END.toISOString());
    assert.equal(persistence.commitState?.watermarkAuthoredAt?.toISOString(), NEXT_RUN_END.toISOString());
    assert.equal(persistence.commits.get("boundary")?.authorEmail, "Dev@Example.COM");
    assert.equal(
      persistence.commits.get("boundary")?.authorEmailNormalized,
      "dev@example.com",
    );
  });

  it("deduplicates the same SHA returned from multiple sorted branches", async () => {
    const persistence = new MemoryPersistence();
    const visited: string[] = [];
    const gitlab = client({
      async listBranches() {
        return {
          items: [branch("z-feature"), branch("a-feature")],
          nextPage: null,
        };
      },
      async listCommits(_projectId, query) {
        visited.push(query.refName ?? "");
        return { items: [commit("shared-sha")], nextPage: null };
      },
    });

    const outcome = await new SyncOrchestrator({
      persistence,
      credentials: credentials().provider,
      clientFactory: () => gitlab,
      now: () => RUN_END,
    }).syncProject(PROJECT);

    assert.equal(outcome.status, "completed");
    assert.deepEqual(visited, ["a-feature", "z-feature"]);
    assert.equal(persistence.commits.size, 1);
    assert.equal(persistence.commitState?.lastBranchCursor, null);
  });

  it("continues at the persisted next branch using the original fixed window", async () => {
    const persistence = new MemoryPersistence();
    const calls: Array<{ branch: string; since: string; until: string }> = [];
    let branchListCalls = 0;
    const gitlab = client({
      async listBranches() {
        branchListCalls += 1;
        return {
          items:
            branchListCalls === 1
              ? [branch("z"), branch("a"), branch("m")]
              : [branch("0-new"), branch("z"), branch("a"), branch("m")],
          nextPage: null,
        };
      },
      async listCommits(_projectId, query) {
        calls.push({
          branch: query.refName ?? "",
          since: query.since.toISOString(),
          until: query.until.toISOString(),
        });
        return { items: [], nextPage: null };
      },
    });
    const creds = credentials();

    const paused = await new SyncOrchestrator({
      persistence,
      credentials: creds.provider,
      clientFactory: () => gitlab,
      now: () => RUN_END,
      budget: {
        shouldStopBetweenBranches: () => true,
      },
    }).syncProject(PROJECT);
    assert.equal(paused.status, "paused");
    assert.match(
      persistence.commitState?.lastBranchCursor ?? "",
      /"nextIndex":1/,
    );
    assert.equal(persistence.commitState?.watermarkAuthoredAt, null);
    assert.equal(
      persistence.completedMrWindows,
      0,
      "a budget pause must not start another sync stream",
    );

    const completed = await new SyncOrchestrator({
      persistence,
      credentials: creds.provider,
      clientFactory: () => gitlab,
      now: () => NEXT_RUN_END,
    }).syncProject(PROJECT);

    assert.equal(completed.status, "completed");
    assert.deepEqual(
      calls.map((call) => call.branch),
      ["a", "m", "z", "0-new"],
    );
    assert.ok(calls.every((call) => call.until === RUN_END.toISOString()));
    const resumedState = persistence.commitState as CommitSyncState | null;
    assert.equal(
      resumedState?.watermarkAuthoredAt?.toISOString(),
      RUN_END.toISOString(),
    );
  });

  it("keeps branch cursor and watermark fixed when a later page fails", async () => {
    const persistence = new MemoryPersistence();
    const pageTwo = { page: 9, perPage: 17 } satisfies GitLabPageCursor;
    const received: GitLabPageCursor[] = [];
    const gitlab = client({
      async listCommits(_projectId, query) {
        if (query.page === undefined) {
          return { items: [commit("partial")], nextPage: pageTwo };
        }
        received.push(query.page);
        throw new Error("page failed");
      },
    });

    await assert.rejects(
      () =>
        new SyncOrchestrator({
          persistence,
          credentials: credentials().provider,
          clientFactory: () => gitlab,
          now: () => RUN_END,
        }).syncProject(PROJECT),
      /page failed/,
    );

    assert.deepEqual(received, [pageTwo]);
    assert.equal(persistence.commits.has("partial"), true);
    assert.match(
      persistence.commitState?.lastBranchCursor ?? "",
      /"branches":\["main"\],"nextIndex":0/,
    );
    assert.equal(persistence.commitState?.watermarkAuthoredAt, null);
    assert.equal(persistence.completedCommitWindows, 0);
  });
});

describe("SyncOrchestrator merge request cursor", () => {
  it("passes GitLab's exact page cursor and advances only after all pages", async () => {
    const persistence = new MemoryPersistence();
    persistence.mrState = {
      updatedAfterCursor: new Date("2026-08-06T00:00:00.000Z"),
    };
    const next = { page: 4, perPage: 23 } satisfies GitLabPageCursor;
    const queries: Array<{
      updatedAfter: string;
      page: GitLabPageCursor | undefined;
    }> = [];
    const gitlab = client({
      async listMergeRequests(_projectId, query) {
        queries.push({
          updatedAfter: query.updatedAfter.toISOString(),
          page: query.page,
        });
        if (query.page === undefined) {
          return {
            items: [mergeRequest(1, "2026-08-06T01:00:00.000Z")],
            nextPage: next,
          };
        }
        return {
          items: [mergeRequest(2, "2026-08-06T02:00:00.000Z")],
          nextPage: null,
        };
      },
    });

    await new SyncOrchestrator({
      persistence,
      credentials: credentials().provider,
      clientFactory: () => gitlab,
      now: () => RUN_END,
    }).syncProject(PROJECT);

    assert.deepEqual(queries[1]?.page, next);
    assert.equal(
      queries[0]?.updatedAfter,
      "2026-08-06T00:00:00.000Z",
    );
    assert.equal(
      persistence.mrState.updatedAfterCursor?.toISOString(),
      RUN_END.toISOString(),
    );
    assert.equal(persistence.mergeRequests.size, 2);
    assert.equal(
      persistence.mergeRequests.get(1)?.authorEmailNormalized,
      "mr@example.com",
    );
  });

  it("does not advance the MR cursor after a mid-page error", async () => {
    const persistence = new MemoryPersistence();
    const originalCursor = new Date("2026-08-06T00:00:00.000Z");
    persistence.mrState = { updatedAfterCursor: originalCursor };
    const next = { page: 2, perPage: 50 } satisfies GitLabPageCursor;
    const gitlab = client({
      async listMergeRequests(_projectId, query) {
        if (query.page === undefined) {
          return {
            items: [mergeRequest(1, "2026-08-06T01:00:00.000Z")],
            nextPage: next,
          };
        }
        throw new Error("MR page failed");
      },
    });

    await assert.rejects(
      () =>
        new SyncOrchestrator({
          persistence,
          credentials: credentials().provider,
          clientFactory: () => gitlab,
          now: () => RUN_END,
        }).syncProject(PROJECT),
      /MR page failed/,
    );

    assert.equal(
      persistence.mrState.updatedAfterCursor?.toISOString(),
      originalCursor.toISOString(),
    );
    assert.equal(persistence.completedMrWindows, 0);
  });
});

describe("SyncOrchestrator credential coalescing", () => {
  it("invalidates a 401 credential and its membership cache, then fails over", async () => {
    const persistence = new MemoryPersistence();
    persistence.candidates = [candidate("bad"), candidate("good")];
    const creds = credentials({ bad: "secret-bad", good: "secret-good" });
    const factoryPats: string[] = [];

    const outcome = await new SyncOrchestrator({
      persistence,
      credentials: creds.provider,
      clientFactory: ({ candidate: selected, pat }) => {
        factoryPats.push(pat);
        return client({
          async getProject() {
            if (selected.connectionId === "bad") {
              throw new GitLabUnauthorizedError();
            }
            return projectRef();
          },
        });
      },
      now: () => RUN_END,
    }).syncProject(PROJECT);

    assert.equal(outcome.status, "completed");
    assert.deepEqual(creds.invalidated, ["bad"]);
    assert.deepEqual(persistence.invalidConnections, ["bad"]);
    assert.deepEqual(persistence.invalidatedMemberships, [
      `user-bad:${PROJECT.gitlabInstanceId}`,
    ]);
    assert.deepEqual(factoryPats, ["secret-bad", "secret-good"]);
    assert.equal(JSON.stringify(outcome).includes("secret-"), false);
  });

  it("writes a project denial on 403/404 without invalidating the PAT", async () => {
    for (const denied of [
      new GitLabProjectForbiddenError(),
      new GitLabProjectNotFoundError(),
    ]) {
      const persistence = new MemoryPersistence();
      persistence.candidates = [candidate("denied"), candidate("allowed")];
      const creds = credentials();

      const outcome = await new SyncOrchestrator({
        persistence,
        credentials: creds.provider,
        clientFactory: ({ candidate: selected }) =>
          client({
            async getProject() {
              if (selected.connectionId === "denied") {
                throw denied;
              }
              return projectRef();
            },
          }),
        now: () => RUN_END,
      }).syncProject(PROJECT);

      assert.equal(outcome.status, "completed");
      assert.deepEqual(creds.invalidated, []);
      assert.deepEqual(persistence.invalidConnections, []);
      assert.deepEqual(persistence.deniedMemberships, [
        `user-denied:${PROJECT.gitlabInstanceId}:${PROJECT.gitlabProjectId}`,
      ]);
    }
  });

  it("returns a typed sync_blocked outcome when every candidate is denied", async () => {
    const persistence = new MemoryPersistence();
    persistence.candidates = [candidate("one"), candidate("two")];

    const outcome = await new SyncOrchestrator({
      persistence,
      credentials: credentials().provider,
      clientFactory: () =>
        client({
          async getProject() {
            throw new GitLabProjectNotFoundError();
          },
        }),
      now: () => RUN_END,
    }).syncProject(PROJECT);

    assert.deepEqual(outcome, {
      status: "sync_blocked",
      code: "SYNC_BLOCKED",
      reason: "no_authorized_candidate",
    });
    assert.equal(persistence.deniedMemberships.length, 2);
  });
});
