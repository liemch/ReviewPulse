/**
 * WP4 + WP5 project access.
 *
 * authorized = ReviewPulse allowlist ∩ GitLab-visible (via user PAT) ∩ enable.
 * Visibility probes use targeted getProject per allowlist id with optional
 * membership cache (TTL default 300s). Fail closed on uncertainty.
 */

import type { PrismaClient } from "@reviewpulse/db";
import type { PatCredentialProvider } from "@reviewpulse/credentials";
import {
  createGitLabAllowlist,
  createGitLabReadClient,
  createPatAuthAdapter,
  createSsrfGuard,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabUnauthorizedError,
  isGitLabError,
  type GitLabErrorCode,
  type GitLabReadClient,
  type GitLabProjectRef,
} from "@reviewpulse/gitlab-client";

import type { ProjectAccessService, ProjectRef } from "./types.js";
import { ConnectionPolicyError } from "./gitlab-connection.js";
import { MembershipCacheStore } from "./membership-cache.js";
import {
  membershipCacheNegativeTtlFromEnv,
  membershipCacheTtlFromEnv,
} from "./membership-cache-config.js";

export type ProjectListItem = {
  gitlabInstanceId: string;
  gitlabProjectId: string;
  pathWithNamespace: string | null;
  name: string | null;
  gitlabVisible: boolean;
  enabled: boolean;
  error: string | null;
};

/** Projects the caller's PAT can actually see, keyed by GitLab project id. */
export type VisibleProject = Pick<
  GitLabProjectRef,
  "id" | "pathWithNamespace" | "name"
>;

/**
 * Outcome of one probe batch. A project id is either in `visible` (200), in
 * `failed` (the probe could not answer), or in neither — which is the only
 * definitive "denied" (403/404). Failures stay per project so one flaky id
 * cannot blank out the projects that answered.
 */
export type AllowlistedProbeResult = {
  visible: Map<string, VisibleProject>;
  failed: Map<string, GitLabErrorCode>;
};

/** Targeted visibility probe — one GitLab request per allowlisted project id. */
export type AllowlistedProjectProbe = (input: {
  connectionId: string;
  instanceId: string;
  baseUrlNormalized: string;
  internal: boolean;
  pat: string;
  projectIds: readonly string[];
}) => Promise<AllowlistedProbeResult>;

const DEFAULT_PROBE_CONCURRENCY = 5;

export function createAllowlistedProjectProbe(
  concurrency = DEFAULT_PROBE_CONCURRENCY,
): AllowlistedProjectProbe {
  return async (input) => {
    if (input.projectIds.length === 0) {
      return { visible: new Map(), failed: new Map() };
    }

    const client = createGitLabReadClient({
      instance: {
        instanceId: input.instanceId,
        baseUrlNormalized: input.baseUrlNormalized,
      },
      auth: createPatAuthAdapter(() => input.pat),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist([
          { url: input.baseUrlNormalized, internal: input.internal },
        ]),
      }),
    });

    return probeAllowlistedProjectIds(client, input.projectIds, concurrency);
  };
}

/**
 * Probes GitLab visibility for explicit allowlist ids via GET /projects/:id.
 * Exported for unit tests with a mock read client.
 *
 * 403/404 is GitLab answering "you cannot see this". Anything else (429 past
 * the retry budget, 5xx, timeout, transport failure) is recorded against that
 * one project id: the caller must fail closed for it without caching a denial
 * and without discarding the ids that did answer. 401 is a credential-wide
 * verdict and still aborts the batch.
 */
export async function probeAllowlistedProjectIds(
  client: Pick<GitLabReadClient, "getProject">,
  projectIds: readonly string[],
  concurrency = DEFAULT_PROBE_CONCURRENCY,
): Promise<AllowlistedProbeResult> {
  const visible = new Map<string, VisibleProject>();
  const failed = new Map<string, GitLabErrorCode>();
  if (projectIds.length === 0) {
    return { visible, failed };
  }

  await mapWithConcurrency(projectIds, concurrency, async (projectId) => {
    try {
      const ref = await client.getProject(projectId);
      visible.set(projectId, {
        id: ref.id,
        pathWithNamespace: ref.pathWithNamespace,
        name: ref.name,
      });
    } catch (error) {
      if (
        error instanceof GitLabProjectForbiddenError ||
        error instanceof GitLabProjectNotFoundError
      ) {
        return;
      }
      if (error instanceof GitLabUnauthorizedError || !isGitLabError(error)) {
        throw error;
      }
      failed.set(projectId, error.code);
    }
  });

  return { visible, failed };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      await fn(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

type ConnectionWithInstance = {
  id: string;
  gitlabInstanceId: string;
  userId: string;
  instance: { baseUrlNormalized: string; internal: boolean; id: string };
};

/**
 * `allowed.ref === null` means "the caller may see it, but this answer came
 * from the cache, which stores the decision only". Display metadata then comes
 * from the allowlist row, never from a placeholder.
 */
type ProjectVisibility =
  | { status: "allowed"; ref: VisibleProject | null }
  | { status: "denied" }
  | { status: "unknown"; reason: GitLabErrorCode };

/** Empty and whitespace-only strings are missing values, not display text. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function probeFailureMessage(reason: GitLabErrorCode): string {
  return reason === "GITLAB_RATE_LIMITED"
    ? "GitLab rate limited"
    : "GitLab unavailable";
}

export class LiveProjectAccessService implements ProjectAccessService {
  private readonly membershipCache: MembershipCacheStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentials: PatCredentialProvider,
    private readonly probeAllowlisted: AllowlistedProjectProbe = createAllowlistedProjectProbe(),
    membershipCache?: MembershipCacheStore,
  ) {
    const ttlSeconds = membershipCacheTtlFromEnv();
    this.membershipCache =
      membershipCache ??
      new MembershipCacheStore(
        prisma,
        ttlSeconds,
        membershipCacheNegativeTtlFromEnv(process.env, ttlSeconds),
      );
  }

  async listForUser(userId: string): Promise<ProjectListItem[]> {
    const connections = await this.prisma.gitLabConnection.findMany({
      where: { userId, status: "active" },
      include: { instance: true },
    });

    const allowlisted = await this.prisma.reviewPulseProjectAllowlist.findMany({
      orderBy: [{ gitlabInstanceId: "asc" }, { gitlabProjectId: "asc" }],
    });
    const enables = await this.prisma.userProjectEnable.findMany({
      where: { userId },
    });
    const enableSet = new Set(
      enables.map((row) => `${row.gitlabInstanceId}:${row.gitlabProjectId}`),
    );

    const out: ProjectListItem[] = [];

    for (const connection of connections) {
      const instanceProjects = allowlisted.filter(
        (row) => row.gitlabInstanceId === connection.gitlabInstanceId,
      );
      if (instanceProjects.length === 0) {
        continue;
      }

      const projectIds = instanceProjects.map((row) => row.gitlabProjectId);
      let visibility: Map<string, ProjectVisibility>;
      try {
        visibility = await this.resolveVisibility(connection, projectIds);
      } catch (error) {
        const message =
          error instanceof GitLabUnauthorizedError
            ? "GitLab credential rejected"
            : "GitLab unavailable";
        for (const project of instanceProjects) {
          out.push({
            gitlabInstanceId: project.gitlabInstanceId,
            gitlabProjectId: project.gitlabProjectId,
            pathWithNamespace: blankToNull(project.pathWithNamespace),
            name: null,
            gitlabVisible: false,
            enabled: enableSet.has(
              `${project.gitlabInstanceId}:${project.gitlabProjectId}`,
            ),
            error: message,
          });
        }
        continue;
      }

      for (const project of instanceProjects) {
        const entry = visibility.get(project.gitlabProjectId);
        const ref = entry?.status === "allowed" ? entry.ref : null;
        const probedPath = blankToNull(ref?.pathWithNamespace);
        const storedPath = blankToNull(project.pathWithNamespace);
        if (probedPath !== null && probedPath !== storedPath) {
          await this.rememberProjectPath(project.id, probedPath);
        }
        out.push({
          gitlabInstanceId: project.gitlabInstanceId,
          gitlabProjectId: project.gitlabProjectId,
          pathWithNamespace: probedPath ?? storedPath,
          name: blankToNull(ref?.name),
          gitlabVisible: entry?.status === "allowed",
          enabled: enableSet.has(
            `${project.gitlabInstanceId}:${project.gitlabProjectId}`,
          ),
          error:
            entry === undefined || entry.status === "unknown"
              ? probeFailureMessage(
                  entry?.reason ?? "GITLAB_UNEXPECTED_STATUS",
                )
              : null,
        });
      }
    }

    return out;
  }

  /**
   * Keeps the allowlist row's display path in step with GitLab so the list
   * stays readable when a later render is served from the cache, which holds
   * the access decision only.
   */
  private async rememberProjectPath(
    allowlistRowId: string,
    pathWithNamespace: string,
  ): Promise<void> {
    await this.prisma.reviewPulseProjectAllowlist.updateMany({
      where: { id: allowlistRowId },
      data: { pathWithNamespace },
    });
  }

  async enable(input: {
    userId: string;
    gitlabInstanceId: string;
    gitlabProjectId: string;
  }): Promise<void> {
    const allowlisted =
      await this.prisma.reviewPulseProjectAllowlist.findUnique({
        where: {
          gitlabInstanceId_gitlabProjectId: {
            gitlabInstanceId: input.gitlabInstanceId,
            gitlabProjectId: input.gitlabProjectId,
          },
        },
      });
    if (allowlisted === null) {
      throw new ConnectionPolicyError("Project is not on the allowlist");
    }

    const connection = await this.prisma.gitLabConnection.findFirst({
      where: {
        userId: input.userId,
        gitlabInstanceId: input.gitlabInstanceId,
        status: "active",
      },
      include: { instance: true },
    });
    if (connection === null) {
      throw new ConnectionPolicyError("No active GitLab connection");
    }

    const visible = await this.resolveVisibility(connection, [
      input.gitlabProjectId,
    ]);
    if (visible.get(input.gitlabProjectId)?.status !== "allowed") {
      throw new ConnectionPolicyError("Project is not visible to your PAT");
    }

    await this.prisma.userProjectEnable.upsert({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId: input.userId,
          gitlabInstanceId: input.gitlabInstanceId,
          gitlabProjectId: input.gitlabProjectId,
        },
      },
      create: {
        userId: input.userId,
        gitlabInstanceId: input.gitlabInstanceId,
        gitlabProjectId: input.gitlabProjectId,
      },
      update: { enabledAt: new Date() },
    });
  }

  async disable(input: {
    userId: string;
    gitlabInstanceId: string;
    gitlabProjectId: string;
  }): Promise<void> {
    await this.prisma.userProjectEnable.deleteMany({
      where: {
        userId: input.userId,
        gitlabInstanceId: input.gitlabInstanceId,
        gitlabProjectId: input.gitlabProjectId,
      },
    });
    await this.membershipCache.invalidateUserProject(
      input.userId,
      input.gitlabInstanceId,
      input.gitlabProjectId,
    );
  }

  async authorizedProjectIds(userId: string): Promise<ProjectRef[]> {
    const items = await this.listForUser(userId);
    return items
      .filter((item) => item.enabled && item.gitlabVisible && item.error === null)
      .map((item) => ({
        gitlabInstanceId: item.gitlabInstanceId,
        gitlabProjectId: item.gitlabProjectId,
      }));
  }

  /**
   * Resolves visibility for allowlisted ids using fresh cache hits and live
   * probes for missing/expired entries. A cache hit carries the decision only,
   * so `ref` stays null there; a probe that could not answer stays "unknown"
   * and is never cached (fail closed without poisoning the next 5 minutes).
   */
  private async resolveVisibility(
    connection: ConnectionWithInstance,
    projectIds: readonly string[],
  ): Promise<Map<string, ProjectVisibility>> {
    const out = new Map<string, ProjectVisibility>();
    if (projectIds.length === 0) {
      return out;
    }

    const fresh = await this.membershipCache.lookupFreshMany(
      connection.userId,
      connection.gitlabInstanceId,
      projectIds,
    );

    const toProbe: string[] = [];
    for (const projectId of projectIds) {
      const cached = fresh.get(projectId);
      if (cached === undefined) {
        toProbe.push(projectId);
        continue;
      }
      out.set(
        projectId,
        cached ? { status: "allowed", ref: null } : { status: "denied" },
      );
    }

    if (toProbe.length === 0) {
      return out;
    }

    let probed: AllowlistedProbeResult;
    try {
      probed = await this.probeAllowlistedProjects(connection, toProbe);
    } catch (error) {
      if (error instanceof GitLabUnauthorizedError) {
        await this.handleGitLabUnauthorized(connection);
      }
      throw error;
    }

    for (const projectId of toProbe) {
      const failure = probed.failed.get(projectId);
      if (failure !== undefined) {
        out.set(projectId, { status: "unknown", reason: failure });
        continue;
      }
      const ref = probed.visible.get(projectId);
      await this.membershipCache.write(
        connection.userId,
        connection.gitlabInstanceId,
        projectId,
        ref !== undefined,
      );
      out.set(
        projectId,
        ref !== undefined
          ? { status: "allowed", ref }
          : { status: "denied" },
      );
    }

    return out;
  }

  private async handleGitLabUnauthorized(
    connection: ConnectionWithInstance,
  ): Promise<void> {
    await this.credentials.invalidateCredential(
      connection.id,
      "gitlab_unauthorized",
    );
    await this.prisma.gitLabConnection.update({
      where: { id: connection.id },
      data: { status: "invalid" },
    });
    await this.membershipCache.invalidateUserInstance(
      connection.userId,
      connection.gitlabInstanceId,
    );
  }

  private async probeAllowlistedProjects(
    connection: ConnectionWithInstance,
    projectIds: readonly string[],
  ): Promise<AllowlistedProbeResult> {
    const pat = await this.credentials.getAccessToken(connection.id);
    return await this.probeAllowlisted({
      connectionId: connection.id,
      instanceId: connection.instance.id,
      baseUrlNormalized: connection.instance.baseUrlNormalized,
      internal: connection.instance.internal,
      pat,
      projectIds,
    });
  }
}
