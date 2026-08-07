/**
 * M2 MR workspace — live GitLab reads, authz-first.
 *
 * Never queries global MR data then filters in-process for authorization.
 * Scope = ReviewPulse-enabled ∩ authorized projects for the acting user, then
 * GitLab live calls with that user's PAT only.
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
  type GitLabMergeRequestApprovals,
  type GitLabMergeRequestDetail,
  type GitLabMergeRequestDiff,
  type GitLabMergeRequestState,
  type GitLabPipelineSummary,
  type GitLabReadClient,
} from "@reviewpulse/gitlab-client";

import { ConnectionPolicyError } from "./gitlab-connection.js";
import type { LiveProjectAccessService } from "./project-access.js";
import type { ProjectRef } from "./types.js";

export type MrListFilters = {
  readonly gitlabInstanceId?: string;
  readonly gitlabProjectId?: string;
  readonly state?: GitLabMergeRequestState;
  readonly authorUsername?: string;
  readonly reviewerUsername?: string;
  /** Cap projects queried when no project filter is set. */
  readonly maxProjects?: number;
  readonly perProjectPageSize?: number;
};

export type MrListItem = {
  readonly gitlabInstanceId: string;
  readonly gitlabProjectId: string;
  readonly pathWithNamespace: string | null;
  readonly iid: number;
  readonly title: string;
  readonly state: string;
  readonly authorUsername: string | null;
  readonly reviewers: readonly string[];
  readonly updatedAt: string;
  readonly webUrl: string | null;
  readonly sha: string | null;
};

export type MrDetailView = {
  readonly gitlabInstanceId: string;
  readonly gitlabProjectId: string;
  readonly pathWithNamespace: string | null;
  readonly mr: GitLabMergeRequestDetail;
  readonly approvals: GitLabMergeRequestApprovals | null;
  readonly pipelines: readonly GitLabPipelineSummary[];
  readonly diffs: readonly GitLabMergeRequestDiff[];
  /** Head SHA at the moment this view was loaded — use for stale checks. */
  readonly reviewedHeadSha: string | null;
};

export type MrAccessDenial = {
  readonly kind: "not_found";
};

export class MrWorkspaceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly projects: LiveProjectAccessService,
    private readonly credentials: PatCredentialProvider,
  ) {}

  async list(userId: string, filters: MrListFilters = {}): Promise<MrListItem[]> {
    const authorized = await this.projects.authorizedProjectIds(userId);
    const scoped = filterAuthorizedProjects(authorized, filters);
    if (scoped.length === 0) {
      return [];
    }

    const pathByKey = await this.loadPathLabels(userId, scoped);
    const maxProjects = Math.min(Math.max(filters.maxProjects ?? 20, 1), 50);
    const perPage = Math.min(Math.max(filters.perProjectPageSize ?? 20, 1), 50);
    const targets = scoped.slice(0, maxProjects);

    const rows: MrListItem[] = [];
    for (const project of targets) {
      try {
        const client = await this.actingReadClient(userId, project.gitlabInstanceId);
        const page = await client.listProjectMergeRequests(project.gitlabProjectId, {
          ...(filters.state === undefined ? {} : { state: filters.state }),
          ...(filters.authorUsername === undefined
            ? {}
            : { authorUsername: filters.authorUsername }),
          ...(filters.reviewerUsername === undefined
            ? {}
            : { reviewerUsername: filters.reviewerUsername }),
          page: { page: 1, perPage },
        });
        const key = projectKey(project);
        for (const mr of page.items) {
          rows.push({
            gitlabInstanceId: project.gitlabInstanceId,
            gitlabProjectId: project.gitlabProjectId,
            pathWithNamespace: pathByKey.get(key) ?? null,
            iid: mr.iid,
            title: mr.title,
            state: mr.state,
            authorUsername: mr.authorUsername,
            reviewers: mr.reviewers,
            updatedAt: mr.updatedAt,
            webUrl: mr.webUrl,
            sha: mr.sha,
          });
        }
      } catch (error) {
        if (error instanceof ConnectionPolicyError) {
          continue;
        }
        if (
          error instanceof GitLabUnauthorizedError ||
          error instanceof GitLabProjectForbiddenError ||
          error instanceof GitLabProjectNotFoundError
        ) {
          continue;
        }
        if (isGitLabError(error)) {
          continue;
        }
        throw error;
      }
    }

    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return rows;
  }

  /**
   * Live MR detail. Unauthorized / invisible projects return `not_found`
   * (no existence leak).
   */
  async getDetail(
    userId: string,
    ref: {
      gitlabInstanceId: string;
      gitlabProjectId: string;
      iid: number;
    },
  ): Promise<MrDetailView | MrAccessDenial> {
    const authorized = await this.projects.authorizedProjectIds(userId);
    const allowed = authorized.some(
      (p) =>
        p.gitlabInstanceId === ref.gitlabInstanceId &&
        p.gitlabProjectId === ref.gitlabProjectId,
    );
    if (!allowed) {
      return { kind: "not_found" };
    }

    const pathByKey = await this.loadPathLabels(userId, [
      {
        gitlabInstanceId: ref.gitlabInstanceId,
        gitlabProjectId: ref.gitlabProjectId,
      },
    ]);

    try {
      const client = await this.actingReadClient(userId, ref.gitlabInstanceId);
      const mr = await client.getMergeRequest(ref.gitlabProjectId, ref.iid);

      let approvals: GitLabMergeRequestApprovals | null = null;
      try {
        approvals = await client.getMergeRequestApprovals(
          ref.gitlabProjectId,
          ref.iid,
        );
      } catch {
        approvals = null;
      }

      let pipelines: GitLabPipelineSummary[] = [];
      try {
        const pipePage = await client.listMergeRequestPipelines(
          ref.gitlabProjectId,
          ref.iid,
          { page: { page: 1, perPage: 10 } },
        );
        pipelines = [...pipePage.items];
      } catch {
        pipelines = [];
      }

      let diffs: GitLabMergeRequestDiff[] = [];
      try {
        const diffPage = await client.listMergeRequestDiffs(
          ref.gitlabProjectId,
          ref.iid,
          { page: { page: 1, perPage: 100 } },
        );
        diffs = [...diffPage.items];
      } catch {
        diffs = [];
      }

      return {
        gitlabInstanceId: ref.gitlabInstanceId,
        gitlabProjectId: ref.gitlabProjectId,
        pathWithNamespace:
          pathByKey.get(projectKey(ref)) ?? null,
        mr,
        approvals,
        pipelines,
        diffs,
        reviewedHeadSha: mr.sha,
      };
    } catch (error) {
      if (
        error instanceof ConnectionPolicyError ||
        error instanceof GitLabUnauthorizedError ||
        error instanceof GitLabProjectForbiddenError ||
        error instanceof GitLabProjectNotFoundError
      ) {
        return { kind: "not_found" };
      }
      if (isGitLabError(error)) {
        return { kind: "not_found" };
      }
      throw error;
    }
  }

  /** Re-fetch live head SHA for stale checks (approve/merge). */
  async getLiveHeadSha(
    userId: string,
    ref: {
      gitlabInstanceId: string;
      gitlabProjectId: string;
      iid: number;
    },
  ): Promise<string | null | MrAccessDenial> {
    const detail = await this.getDetail(userId, ref);
    if ("kind" in detail) {
      return detail;
    }
    return detail.mr.sha;
  }

  async actingReadClient(
    userId: string,
    gitlabInstanceId: string,
  ): Promise<GitLabReadClient> {
    const connection = await this.prisma.gitLabConnection.findFirst({
      where: {
        userId,
        gitlabInstanceId,
        status: "active",
      },
      include: { instance: true },
    });
    if (!connection) {
      throw new ConnectionPolicyError("no_active_connection");
    }

    const pat = await this.credentials.getAccessToken(connection.id);
    return createGitLabReadClient({
      instance: {
        instanceId: connection.instance.id,
        baseUrlNormalized: connection.instance.baseUrlNormalized,
      },
      auth: createPatAuthAdapter(() => pat),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist([
          {
            url: connection.instance.baseUrlNormalized,
            internal: connection.instance.internal,
          },
        ]),
      }),
    });
  }

  private async loadPathLabels(
    userId: string,
    projects: readonly ProjectRef[],
  ): Promise<Map<string, string | null>> {
    const items = await this.projects.listForUser(userId);
    const map = new Map<string, string | null>();
    for (const project of projects) {
      const match = items.find(
        (item) =>
          item.gitlabInstanceId === project.gitlabInstanceId &&
          item.gitlabProjectId === project.gitlabProjectId,
      );
      map.set(projectKey(project), match?.pathWithNamespace ?? null);
    }
    return map;
  }
}

function projectKey(ref: ProjectRef): string {
  return `${ref.gitlabInstanceId}:${ref.gitlabProjectId}`;
}

function filterAuthorizedProjects(
  authorized: readonly ProjectRef[],
  filters: MrListFilters,
): ProjectRef[] {
  return authorized.filter((project) => {
    if (
      filters.gitlabInstanceId !== undefined &&
      project.gitlabInstanceId !== filters.gitlabInstanceId
    ) {
      return false;
    }
    if (
      filters.gitlabProjectId !== undefined &&
      project.gitlabProjectId !== filters.gitlabProjectId
    ) {
      return false;
    }
    return true;
  });
}
