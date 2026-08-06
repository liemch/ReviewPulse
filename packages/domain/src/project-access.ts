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
  type GitLabReadClient,
  type GitLabProjectRef,
} from "@reviewpulse/gitlab-client";

import type { ProjectAccessService, ProjectRef } from "./types.js";
import { ConnectionPolicyError } from "./gitlab-connection.js";
import { MembershipCacheStore } from "./membership-cache.js";
import { membershipCacheTtlFromEnv } from "./membership-cache-config.js";

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

/** Targeted visibility probe — one GitLab request per allowlisted project id. */
export type AllowlistedProjectProbe = (input: {
  connectionId: string;
  instanceId: string;
  baseUrlNormalized: string;
  internal: boolean;
  pat: string;
  projectIds: readonly string[];
}) => Promise<Map<string, VisibleProject>>;

const DEFAULT_PROBE_CONCURRENCY = 5;

export function createAllowlistedProjectProbe(
  concurrency = DEFAULT_PROBE_CONCURRENCY,
): AllowlistedProjectProbe {
  return async (input) => {
    if (input.projectIds.length === 0) {
      return new Map();
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
 */
export async function probeAllowlistedProjectIds(
  client: Pick<GitLabReadClient, "getProject">,
  projectIds: readonly string[],
  concurrency = DEFAULT_PROBE_CONCURRENCY,
): Promise<Map<string, VisibleProject>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const visible = new Map<string, VisibleProject>();

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
      throw error;
    }
  });

  return visible;
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

export class LiveProjectAccessService implements ProjectAccessService {
  private readonly membershipCache: MembershipCacheStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentials: PatCredentialProvider,
    private readonly probeAllowlisted: AllowlistedProjectProbe = createAllowlistedProjectProbe(),
    membershipCache?: MembershipCacheStore,
  ) {
    this.membershipCache =
      membershipCache ??
      new MembershipCacheStore(prisma, membershipCacheTtlFromEnv());
  }

  async listForUser(userId: string): Promise<ProjectListItem[]> {
    const connections = await this.prisma.gitLabConnection.findMany({
      where: { userId, status: "active" },
      include: { instance: true },
    });

    const allowlisted = await this.prisma.reviewPulseProjectAllowlist.findMany();
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
      let visibility: Map<string, VisibleProject | null>;
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
            pathWithNamespace: project.pathWithNamespace,
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
        const ref = visibility.get(project.gitlabProjectId);
        const gitlabVisible = ref !== undefined && ref !== null;
        out.push({
          gitlabInstanceId: project.gitlabInstanceId,
          gitlabProjectId: project.gitlabProjectId,
          pathWithNamespace:
            ref?.pathWithNamespace && ref.pathWithNamespace.length > 0
              ? ref.pathWithNamespace
              : project.pathWithNamespace,
          name:
            ref?.name && ref.name.length > 0 ? ref.name : null,
          gitlabVisible,
          enabled: enableSet.has(
            `${project.gitlabInstanceId}:${project.gitlabProjectId}`,
          ),
          error: null,
        });
      }
    }

    return out;
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
    const ref = visible.get(input.gitlabProjectId);
    if (ref === undefined || ref === null) {
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
   * probes for missing/expired entries. Map values: VisibleProject when
   * allowed, null when denied, absent keys when uncertain (fail closed).
   */
  private async resolveVisibility(
    connection: ConnectionWithInstance,
    projectIds: readonly string[],
  ): Promise<Map<string, VisibleProject | null>> {
    const out = new Map<string, VisibleProject | null>();
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
        out.set(projectId, cached
          ? { id: Number(projectId), pathWithNamespace: "", name: "" }
          : null);
    }

    if (toProbe.length === 0) {
      return out;
    }

    let probed: Map<string, VisibleProject>;
    try {
      probed = await this.probeAllowlistedProjects(connection, toProbe);
    } catch (error) {
      if (error instanceof GitLabUnauthorizedError) {
        await this.handleGitLabUnauthorized(connection);
      }
      throw error;
    }

    for (const projectId of toProbe) {
      const ref = probed.get(projectId);
      if (ref) {
        await this.membershipCache.write(
          connection.userId,
          connection.gitlabInstanceId,
          projectId,
          true,
        );
        out.set(projectId, ref);
      } else {
        await this.membershipCache.write(
          connection.userId,
          connection.gitlabInstanceId,
          projectId,
          false,
        );
        out.set(projectId, null);
      }
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
  ): Promise<Map<string, VisibleProject>> {
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
