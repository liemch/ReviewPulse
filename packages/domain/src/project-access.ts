/**
 * WP4 live project access — no membership cache.
 *
 * authorized = ReviewPulse allowlist ∩ GitLab-visible (via user PAT) ∩ enable.
 * Fail closed when GitLab cannot be reached or the user has no connection.
 */

import type { PrismaClient } from "@reviewpulse/db";
import type { PatCredentialProvider } from "@reviewpulse/credentials";
import {
  createGitLabAllowlist,
  createGitLabReadClient,
  createPatAuthAdapter,
  createSsrfGuard,
  drainPages,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabUnauthorizedError,
  type GitLabProjectRef,
} from "@reviewpulse/gitlab-client";

import type { ProjectAccessService, ProjectRef } from "./types.js";
import { ConnectionPolicyError } from "./gitlab-connection.js";

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
 * Loads GitLab-visible projects for one connection. The default implementation
 * drains the WP2 read client under the SSRF guard; tests inject a stub.
 */
export type VisibleProjectsLoader = (input: {
  connectionId: string;
  instanceId: string;
  baseUrlNormalized: string;
  internal: boolean;
  pat: string;
}) => Promise<Map<string, VisibleProject>>;

export function createVisibleProjectsLoader(): VisibleProjectsLoader {
  return async (input) => {
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

    try {
      const projects = await drainPages(
        (cursor) => client.listAccessibleProjects({ page: cursor }),
        { perPage: 100, maxPages: 100, maxItems: 10_000 },
      );
      return new Map(
        projects.map((project) => [String(project.id), project] as const),
      );
    } catch (error) {
      // 403/404 mean "not visible to this PAT", not "GitLab is broken" (D4).
      if (
        error instanceof GitLabProjectForbiddenError ||
        error instanceof GitLabProjectNotFoundError
      ) {
        return new Map();
      }
      throw error;
    }
  };
}

export class LiveProjectAccessService implements ProjectAccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentials: PatCredentialProvider,
    private readonly loadVisible: VisibleProjectsLoader = createVisibleProjectsLoader(),
  ) {}

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

      let visible: Map<string, VisibleProject>;
      try {
        visible = await this.loadVisibleProjects(connection);
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
        const ref = visible.get(project.gitlabProjectId);
        out.push({
          gitlabInstanceId: project.gitlabInstanceId,
          gitlabProjectId: project.gitlabProjectId,
          pathWithNamespace:
            ref?.pathWithNamespace ?? project.pathWithNamespace,
          name: ref?.name ?? null,
          gitlabVisible: ref !== undefined,
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

    const visible = await this.loadVisibleProjects(connection);
    if (!visible.has(input.gitlabProjectId)) {
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

  private async loadVisibleProjects(connection: {
    id: string;
    gitlabInstanceId: string;
    instance: { baseUrlNormalized: string; internal: boolean; id: string };
  }): Promise<Map<string, VisibleProject>> {
    const pat = await this.credentials.getAccessToken(connection.id);
    return await this.loadVisible({
      connectionId: connection.id,
      instanceId: connection.instance.id,
      baseUrlNormalized: connection.instance.baseUrlNormalized,
      internal: connection.instance.internal,
      pat,
    });
  }
}
