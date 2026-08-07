/**
 * WP6 incremental GitLab sync.
 *
 * Credential access and the GitLab client are injected so plaintext PATs stay
 * inside the worker-side composition boundary. The orchestrator never logs or
 * returns a token.
 */
import {
  NoActiveCredentialError,
  type PatCredentialProvider,
} from "@reviewpulse/credentials";
import type { PrismaClient } from "@reviewpulse/db";
import {
  createGitLabAllowlist,
  createGitLabReadClient,
  createPatAuthAdapter,
  createSsrfGuard,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabUnauthorizedError,
  type GitLabCommit,
  type GitLabMergeRequest,
  type GitLabPageCursor,
  type GitLabReadClient,
} from "@reviewpulse/gitlab-client";

const EPOCH = new Date(0);
/**
 * Cold-start commit floor.
 *
 * Some GitLab instances return an empty commit list when `since` is the Unix
 * epoch (or nearby early-1970s timestamps). A 1980-01-01 floor still means
 * "full history" for ReviewPulse while staying compatible with live GitLab.
 */
export const COMMIT_COLD_START_SINCE = new Date("1980-01-01T00:00:00.000Z");
export const DEFAULT_COMMIT_LOOKBACK_OVERLAP_MS = 15 * 60 * 1_000;

export type SyncProject = {
  readonly gitlabInstanceId: string;
  readonly gitlabProjectId: string;
};

export type SyncCandidate = {
  readonly connectionId: string;
  readonly userId: string;
  readonly instanceId: string;
  readonly baseUrlNormalized: string;
  readonly internal: boolean;
};

export type CommitSyncState = {
  readonly watermarkAuthoredAt: Date | null;
  readonly lastFullWindowStart: Date | null;
  readonly lastFullWindowEnd: Date | null;
  readonly lastBranchCursor: string | null;
};

export type MrSyncState = {
  readonly updatedAfterCursor: Date | null;
};

export type CommitCacheWrite = {
  readonly gitlabInstanceId: string;
  readonly gitlabProjectId: string;
  readonly sha: string;
  readonly authorEmail: string | null;
  readonly authorEmailNormalized: string | null;
  readonly authoredAt: Date;
  readonly title: string | null;
  readonly webUrl: string | null;
  readonly rawPayloadUpdatedAt: Date;
};

export type MergeRequestCacheWrite = {
  readonly gitlabInstanceId: string;
  readonly gitlabProjectId: string;
  readonly iid: number;
  readonly title: string | null;
  readonly state: string | null;
  readonly authorEmail: string | null;
  readonly authorEmailNormalized: string | null;
  readonly headSha: string | null;
  readonly webUrl: string | null;
  readonly updatedAt: Date;
};

/** Persistence seam. Its Prisma implementation is exported for worker wiring. */
export interface SyncPersistence {
  findCandidates(project: SyncProject): Promise<readonly SyncCandidate[]>;
  markConnectionInvalid(connectionId: string): Promise<void>;
  invalidateMembershipUserInstance(
    userId: string,
    gitlabInstanceId: string,
  ): Promise<void>;
  denyMembership(
    userId: string,
    project: SyncProject,
    checkedAt: Date,
  ): Promise<void>;
  getCommitState(project: SyncProject): Promise<CommitSyncState | null>;
  beginCommitWindow(
    project: SyncProject,
    windowStart: Date,
    windowEnd: Date,
    firstBranchCursor: string | null,
  ): Promise<void>;
  upsertCommit(value: CommitCacheWrite): Promise<void>;
  advanceCommitBranch(
    project: SyncProject,
    nextBranchCursor: string | null,
  ): Promise<void>;
  completeCommitWindow(project: SyncProject, watermark: Date): Promise<void>;
  getMrState(project: SyncProject): Promise<MrSyncState | null>;
  upsertMergeRequest(value: MergeRequestCacheWrite): Promise<void>;
  completeMrWindow(project: SyncProject, updatedAfterCursor: Date): Promise<void>;
}

export type SyncGitLabClient = Pick<
  GitLabReadClient,
  "getProject" | "listBranches" | "listCommits" | "listMergeRequests"
>;

export type SyncGitLabClientFactory = (input: {
  readonly candidate: SyncCandidate;
  readonly pat: string;
}) => SyncGitLabClient;

export interface SyncBudget {
  /** Called only after a branch has fully drained and before the next branch. */
  shouldStopBetweenBranches(input: {
    readonly completedBranches: number;
    readonly nextBranch: string;
  }): boolean | Promise<boolean>;
}

export type SyncCompletedOutcome = {
  readonly status: "completed";
  readonly commitsUpserted: number;
  readonly mergeRequestsUpserted: number;
};

export type SyncPausedOutcome = {
  readonly status: "paused";
  readonly commitsUpserted: number;
  readonly mergeRequestsUpserted: number;
  readonly nextBranch: string;
};

export type SyncBlockedOutcome = {
  readonly status: "sync_blocked";
  readonly code: "SYNC_BLOCKED";
  readonly reason: "no_authorized_candidate";
};

export type SyncOutcome =
  | SyncCompletedOutcome
  | SyncPausedOutcome
  | SyncBlockedOutcome;

export class SyncBlockedError extends Error {
  readonly code = "SYNC_BLOCKED" as const;
  readonly safeForClient = true as const;

  constructor() {
    super("No authorized GitLab connection is available");
    this.name = "SyncBlockedError";
  }
}

export type SyncOrchestratorDeps = {
  readonly persistence: SyncPersistence;
  readonly credentials: Pick<
    PatCredentialProvider,
    "getAccessToken" | "invalidateCredential"
  >;
  readonly clientFactory?: SyncGitLabClientFactory;
  readonly budget?: SyncBudget;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly commitLookbackOverlapMs?: number;
};

type CommitRunResult =
  | { status: "completed"; upserted: number }
  | { status: "paused"; upserted: number; nextBranch: string };

export class SyncOrchestrator {
  readonly #persistence: SyncPersistence;
  readonly #credentials: SyncOrchestratorDeps["credentials"];
  readonly #clientFactory: SyncGitLabClientFactory;
  readonly #budget: SyncBudget | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => Date;
  readonly #overlapMs: number;

  constructor(deps: SyncOrchestratorDeps) {
    if (
      deps.commitLookbackOverlapMs !== undefined &&
      (!Number.isFinite(deps.commitLookbackOverlapMs) ||
        deps.commitLookbackOverlapMs < 0)
    ) {
      throw new TypeError("commitLookbackOverlapMs must be non-negative");
    }
    this.#persistence = deps.persistence;
    this.#credentials = deps.credentials;
    this.#clientFactory = deps.clientFactory ?? createDefaultSyncGitLabClient;
    this.#budget = deps.budget;
    this.#signal = deps.signal;
    this.#now = deps.now ?? (() => new Date());
    this.#overlapMs =
      deps.commitLookbackOverlapMs ?? DEFAULT_COMMIT_LOOKBACK_OVERLAP_MS;
  }

  async syncProject(project: SyncProject): Promise<SyncOutcome> {
    const candidates = await this.#persistence.findCandidates(project);

    for (const candidate of candidates) {
      let client: SyncGitLabClient;
      try {
        const pat = await this.#credentials.getAccessToken(
          candidate.connectionId,
        );
        client = this.#clientFactory({ candidate, pat });
        await client.getProject(
          project.gitlabProjectId,
          this.#signal === undefined ? undefined : { signal: this.#signal },
        );
      } catch (error) {
        if (error instanceof NoActiveCredentialError) {
          await this.#invalidateMissingCredential(candidate);
          continue;
        }
        if (error instanceof GitLabUnauthorizedError) {
          await this.#invalidateUnauthorized(candidate);
          continue;
        }
        if (isProjectDenied(error)) {
          await this.#denyProject(candidate, project);
          continue;
        }
        throw error;
      }

      try {
        const commits = await this.#syncCommits(project, client);
        if (commits.status === "paused") {
          return {
            status: "paused",
            commitsUpserted: commits.upserted,
            mergeRequestsUpserted: 0,
            nextBranch: commits.nextBranch,
          };
        }
        const mergeRequestsUpserted = await this.#syncMergeRequests(
          project,
          client,
        );
        return {
          status: "completed",
          commitsUpserted: commits.upserted,
          mergeRequestsUpserted,
        };
      } catch (error) {
        if (error instanceof GitLabUnauthorizedError) {
          await this.#invalidateUnauthorized(candidate);
          continue;
        }
        if (isProjectDenied(error)) {
          await this.#denyProject(candidate, project);
          continue;
        }
        throw error;
      }
    }

    return {
      status: "sync_blocked",
      code: "SYNC_BLOCKED",
      reason: "no_authorized_candidate",
    };
  }

  async #syncCommits(
    project: SyncProject,
    client: SyncGitLabClient,
  ): Promise<CommitRunResult> {
    const discoveredBranches = await listAllBranchNames(
      client,
      project.gitlabProjectId,
      this.#signal,
    );
    const prior = await this.#persistence.getCommitState(project);
    const continuing =
      prior?.lastBranchCursor !== null &&
      prior?.lastBranchCursor !== undefined &&
      prior.lastFullWindowStart !== null &&
      prior.lastFullWindowEnd !== null;

    const windowEnd = continuing
      ? prior.lastFullWindowEnd
      : copyDate(this.#now());
    const windowStart = continuing
      ? prior.lastFullWindowStart
      : prior?.watermarkAuthoredAt
        ? new Date(
            Math.max(
              COMMIT_COLD_START_SINCE.getTime(),
              prior.watermarkAuthoredAt.getTime() - this.#overlapMs,
            ),
          )
        : copyDate(COMMIT_COLD_START_SINCE);
    const savedContinuation = continuing
      ? decodeBranchContinuation(prior.lastBranchCursor as string)
      : null;
    let branches = discoveredBranches;
    let startIndex = 0;
    if (savedContinuation !== null) {
      const known = new Set(savedContinuation.branches);
      const added = discoveredBranches.filter((branch) => !known.has(branch));
      branches = [...savedContinuation.branches, ...added];
      startIndex = Math.min(savedContinuation.nextIndex, branches.length);
      if (added.length > 0) {
        await this.#persistence.advanceCommitBranch(
          project,
          encodeBranchContinuation(branches, startIndex),
        );
      }
    } else if (continuing) {
      // Backward-compatible fallback for a pre-snapshot branch-name cursor.
      startIndex = lowerBound(branches, prior.lastBranchCursor as string);
    }

    if (!continuing) {
      await this.#persistence.beginCommitWindow(
        project,
        windowStart,
        windowEnd,
        branches.length > 0 ? encodeBranchContinuation(branches, 0) : null,
      );
    }

    let upserted = 0;
    let completedBranches = 0;
    for (let index = startIndex; index < branches.length; index += 1) {
      const branch = branches[index] as string;
      let cursor: GitLabPageCursor | undefined;
      const seenCursors = new Set<string>();
      do {
        const page = await client.listCommits(
          project.gitlabProjectId,
          {
            since: copyDate(windowStart),
            until: copyDate(windowEnd),
            refName: branch,
            ...(cursor === undefined ? {} : { page: cursor }),
          },
          this.#signal === undefined ? undefined : { signal: this.#signal },
        );
        for (const commit of page.items) {
          await this.#persistence.upsertCommit(
            toCommitWrite(project, commit, windowEnd),
          );
          upserted += 1;
        }
        cursor = checkedNextCursor(page.nextPage, seenCursors);
      } while (cursor !== undefined);

      completedBranches += 1;
      const nextBranch = branches[index + 1] ?? null;
      // The final cursor is cleared together with the watermark. A crash after
      // the last branch therefore replays that branch instead of losing the
      // completed window before its terminal state can be committed.
      if (nextBranch !== null) {
        await this.#persistence.advanceCommitBranch(
          project,
          encodeBranchContinuation(branches, index + 1),
        );
      }
      if (
        nextBranch !== null &&
        (await this.#budget?.shouldStopBetweenBranches({
          completedBranches,
          nextBranch,
        }))
      ) {
        return { status: "paused", upserted, nextBranch };
      }
    }

    await this.#persistence.completeCommitWindow(project, windowEnd);
    return { status: "completed", upserted };
  }

  async #syncMergeRequests(
    project: SyncProject,
    client: SyncGitLabClient,
  ): Promise<number> {
    const state = await this.#persistence.getMrState(project);
    const updatedAfter = copyDate(state?.updatedAfterCursor ?? EPOCH);
    const runEnd = copyDate(this.#now());
    let cursor: GitLabPageCursor | undefined;
    const seenCursors = new Set<string>();
    let upserted = 0;

    do {
      const page = await client.listMergeRequests(
        project.gitlabProjectId,
        {
          updatedAfter,
          state: "all",
          ...(cursor === undefined ? {} : { page: cursor }),
        },
        this.#signal === undefined ? undefined : { signal: this.#signal },
      );
      for (const mergeRequest of page.items) {
        await this.#persistence.upsertMergeRequest(
          toMergeRequestWrite(project, mergeRequest),
        );
        upserted += 1;
      }
      cursor = checkedNextCursor(page.nextPage, seenCursors);
    } while (cursor !== undefined);

    await this.#persistence.completeMrWindow(project, runEnd);
    return upserted;
  }

  async #invalidateUnauthorized(candidate: SyncCandidate): Promise<void> {
    await this.#credentials.invalidateCredential(
      candidate.connectionId,
      "gitlab_unauthorized",
    );
    await this.#persistence.markConnectionInvalid(candidate.connectionId);
    await this.#persistence.invalidateMembershipUserInstance(
      candidate.userId,
      candidate.instanceId,
    );
  }

  async #invalidateMissingCredential(candidate: SyncCandidate): Promise<void> {
    await this.#persistence.markConnectionInvalid(candidate.connectionId);
    await this.#persistence.invalidateMembershipUserInstance(
      candidate.userId,
      candidate.instanceId,
    );
  }

  async #denyProject(
    candidate: SyncCandidate,
    project: SyncProject,
  ): Promise<void> {
    await this.#persistence.denyMembership(
      candidate.userId,
      project,
      copyDate(this.#now()),
    );
  }
}

export function createDefaultSyncGitLabClient(input: {
  readonly candidate: SyncCandidate;
  readonly pat: string;
}): SyncGitLabClient {
  return createGitLabReadClient({
    instance: {
      instanceId: input.candidate.instanceId,
      baseUrlNormalized: input.candidate.baseUrlNormalized,
    },
    auth: createPatAuthAdapter(() => input.pat),
    ssrf: createSsrfGuard({
      allowlist: createGitLabAllowlist([
        {
          url: input.candidate.baseUrlNormalized,
          internal: input.candidate.internal,
        },
      ]),
    }),
  });
}

export class PrismaSyncPersistence implements SyncPersistence {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly membershipDeniedTtlMs = 300_000,
  ) {}

  async findCandidates(project: SyncProject): Promise<readonly SyncCandidate[]> {
    const allowlisted =
      await this.prisma.reviewPulseProjectAllowlist.findUnique({
        where: { gitlabInstanceId_gitlabProjectId: project },
        select: { id: true },
      });
    if (allowlisted === null) {
      return [];
    }
    const rows = await this.prisma.gitLabConnection.findMany({
      where: {
        gitlabInstanceId: project.gitlabInstanceId,
        status: "active",
        user: {
          status: "active",
          projectEnables: {
            some: {
              gitlabInstanceId: project.gitlabInstanceId,
              gitlabProjectId: project.gitlabProjectId,
            },
          },
        },
      },
      include: { instance: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      connectionId: row.id,
      userId: row.userId,
      instanceId: row.gitlabInstanceId,
      baseUrlNormalized: row.instance.baseUrlNormalized,
      internal: row.instance.internal,
    }));
  }

  async markConnectionInvalid(connectionId: string): Promise<void> {
    await this.prisma.gitLabConnection.updateMany({
      where: { id: connectionId, status: "active" },
      data: { status: "invalid" },
    });
  }

  async invalidateMembershipUserInstance(
    userId: string,
    gitlabInstanceId: string,
  ): Promise<void> {
    await this.prisma.membershipCache.deleteMany({
      where: { userId, gitlabInstanceId },
    });
  }

  async denyMembership(
    userId: string,
    project: SyncProject,
    checkedAt: Date,
  ): Promise<void> {
    const expiresAt = new Date(checkedAt.getTime() + this.membershipDeniedTtlMs);
    await this.prisma.membershipCache.upsert({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId,
          gitlabInstanceId: project.gitlabInstanceId,
          gitlabProjectId: project.gitlabProjectId,
        },
      },
      create: {
        userId,
        gitlabInstanceId: project.gitlabInstanceId,
        gitlabProjectId: project.gitlabProjectId,
        allowed: false,
        checkedAt,
        expiresAt,
      },
      update: { allowed: false, checkedAt, expiresAt },
    });
  }

  async getCommitState(project: SyncProject): Promise<CommitSyncState | null> {
    return await this.prisma.commitSyncState.findUnique({
      where: { gitlabInstanceId_gitlabProjectId: project },
      select: {
        watermarkAuthoredAt: true,
        lastFullWindowStart: true,
        lastFullWindowEnd: true,
        lastBranchCursor: true,
      },
    });
  }

  async beginCommitWindow(
    project: SyncProject,
    windowStart: Date,
    windowEnd: Date,
    firstBranchCursor: string | null,
  ): Promise<void> {
    await this.prisma.commitSyncState.upsert({
      where: { gitlabInstanceId_gitlabProjectId: project },
      create: {
        ...project,
        lastFullWindowStart: windowStart,
        lastFullWindowEnd: windowEnd,
        lastBranchCursor: firstBranchCursor,
      },
      update: {
        lastFullWindowStart: windowStart,
        lastFullWindowEnd: windowEnd,
        lastBranchCursor: firstBranchCursor,
      },
    });
  }

  async upsertCommit(value: CommitCacheWrite): Promise<void> {
    await this.prisma.commitCache.upsert({
      where: {
        gitlabInstanceId_gitlabProjectId_sha: {
          gitlabInstanceId: value.gitlabInstanceId,
          gitlabProjectId: value.gitlabProjectId,
          sha: value.sha,
        },
      },
      create: value,
      update: {
        authorEmail: value.authorEmail,
        authorEmailNormalized: value.authorEmailNormalized,
        authoredAt: value.authoredAt,
        title: value.title,
        webUrl: value.webUrl,
        rawPayloadUpdatedAt: value.rawPayloadUpdatedAt,
      },
    });
  }

  async advanceCommitBranch(
    project: SyncProject,
    nextBranchCursor: string | null,
  ): Promise<void> {
    await this.prisma.commitSyncState.update({
      where: { gitlabInstanceId_gitlabProjectId: project },
      data: { lastBranchCursor: nextBranchCursor },
    });
  }

  async completeCommitWindow(
    project: SyncProject,
    watermark: Date,
  ): Promise<void> {
    await this.prisma.commitSyncState.update({
      where: { gitlabInstanceId_gitlabProjectId: project },
      data: { watermarkAuthoredAt: watermark, lastBranchCursor: null },
    });
  }

  async getMrState(project: SyncProject): Promise<MrSyncState | null> {
    return await this.prisma.mrSyncState.findUnique({
      where: { gitlabInstanceId_gitlabProjectId: project },
      select: { updatedAfterCursor: true },
    });
  }

  async upsertMergeRequest(value: MergeRequestCacheWrite): Promise<void> {
    await this.prisma.mergeRequestCache.upsert({
      where: {
        gitlabInstanceId_gitlabProjectId_iid: {
          gitlabInstanceId: value.gitlabInstanceId,
          gitlabProjectId: value.gitlabProjectId,
          iid: value.iid,
        },
      },
      create: value,
      update: {
        title: value.title,
        state: value.state,
        authorEmail: value.authorEmail,
        authorEmailNormalized: value.authorEmailNormalized,
        headSha: value.headSha,
        webUrl: value.webUrl,
        updatedAt: value.updatedAt,
      },
    });
  }

  async completeMrWindow(
    project: SyncProject,
    updatedAfterCursor: Date,
  ): Promise<void> {
    await this.prisma.mrSyncState.upsert({
      where: { gitlabInstanceId_gitlabProjectId: project },
      create: { ...project, updatedAfterCursor },
      update: { updatedAfterCursor },
    });
  }
}

async function listAllBranchNames(
  client: SyncGitLabClient,
  projectId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const names = new Set<string>();
  let cursor: GitLabPageCursor | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.listBranches(
      projectId,
      {
        ...(cursor === undefined ? {} : { page: cursor }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    for (const branch of page.items) {
      names.add(branch.name);
    }
    cursor = checkedNextCursor(page.nextPage, seenCursors);
  } while (cursor !== undefined);
  return [...names].sort((left, right) => left.localeCompare(right, "en"));
}

function toCommitWrite(
  project: SyncProject,
  commit: GitLabCommit,
  rawPayloadUpdatedAt: Date,
): CommitCacheWrite {
  const authorEmail = cleanEmail(commit.authorEmail);
  return {
    ...project,
    sha: commit.id,
    authorEmail,
    authorEmailNormalized: normalizeAuthorEmail(authorEmail),
    authoredAt: new Date(commit.authoredDate),
    title: commit.title || null,
    webUrl: commit.webUrl,
    rawPayloadUpdatedAt: copyDate(rawPayloadUpdatedAt),
  };
}

function toMergeRequestWrite(
  project: SyncProject,
  mergeRequest: GitLabMergeRequest,
): MergeRequestCacheWrite {
  const authorEmail = cleanEmail(mergeRequest.authorEmail);
  return {
    ...project,
    iid: mergeRequest.iid,
    title: mergeRequest.title || null,
    state: mergeRequest.state || null,
    authorEmail,
    authorEmailNormalized: normalizeAuthorEmail(authorEmail),
    headSha: mergeRequest.sha,
    webUrl: mergeRequest.webUrl,
    updatedAt: new Date(mergeRequest.updatedAt),
  };
}

export function normalizeAuthorEmail(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.normalize("NFKC").toLowerCase();
  return normalized.includes("@") ? normalized : null;
}

function cleanEmail(value: string | null): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

function isProjectDenied(
  error: unknown,
): error is GitLabProjectForbiddenError | GitLabProjectNotFoundError {
  return (
    error instanceof GitLabProjectForbiddenError ||
    error instanceof GitLabProjectNotFoundError
  );
}

type BranchContinuation = {
  v: 1;
  branches: string[];
  nextIndex: number;
};

function encodeBranchContinuation(
  branches: readonly string[],
  nextIndex: number,
): string {
  return JSON.stringify({ v: 1, branches, nextIndex });
}

function decodeBranchContinuation(value: string): BranchContinuation | null {
  try {
    const parsed = JSON.parse(value) as Partial<BranchContinuation>;
    if (
      parsed.v !== 1 ||
      !Array.isArray(parsed.branches) ||
      !parsed.branches.every((branch) => typeof branch === "string") ||
      !Number.isSafeInteger(parsed.nextIndex) ||
      (parsed.nextIndex ?? -1) < 0
    ) {
      return null;
    }
    return {
      v: 1,
      branches: [...parsed.branches],
      nextIndex: parsed.nextIndex as number,
    };
  } catch {
    return null;
  }
}

function lowerBound(values: readonly string[], target: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] as string).localeCompare(target, "en") < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function checkedNextCursor(
  next: GitLabPageCursor | null,
  seen: Set<string>,
): GitLabPageCursor | undefined {
  if (next === null) {
    return undefined;
  }
  const key = `${next.page}:${next.perPage}`;
  if (seen.has(key)) {
    throw new Error("GitLab pagination cursor repeated");
  }
  seen.add(key);
  return next;
}

