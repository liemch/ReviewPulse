/**
 * `GitLabReadClient` — the only surface callers use for reads.
 *
 * Read-only is a property of the type, not a convention: every method here
 * goes through `executor.requestJson`, which has no method parameter and whose
 * transport defaults to GET. Write mutations live in `write-client.ts`.
 */

import type { GitLabAuthAdapter } from "./auth.js";
import { GitLabInvalidConfigError } from "./errors.js";
import {
  createRequestExecutor,
  type GitLabRequestExecutor,
  type RawResponse,
  type RouteScope,
  type SleepFn,
} from "./http.js";
import { resolveLimits, type ClientLimits } from "./limits.js";
import {
  asArray,
  mapBranch,
  mapCommit,
  mapMergeRequest,
  mapMergeRequestApprovals,
  mapMergeRequestDetail,
  mapMergeRequestDiff,
  mapPipelineSummary,
  mapProject,
  mapUser,
} from "./mappers.js";
import {
  parseNextCursor,
  type GitLabPageCursor,
  type Page,
} from "./pagination.js";
import { createSsrfGuard, type SsrfGuard } from "./ssrf.js";
import {
  createPinnedNodeTransport,
  type GitLabHttpTransport,
} from "./transport.js";
import type {
  GitLabBranchRef,
  GitLabCommit,
  GitLabInstanceContext,
  GitLabMergeRequest,
  GitLabMergeRequestApprovals,
  GitLabMergeRequestDetail,
  GitLabMergeRequestDiff,
  GitLabPipelineSummary,
  GitLabProjectRef,
  GitLabUser,
  ListCommitsQuery,
  ListMergeRequestsQuery,
  ListOptions,
  ListProjectMergeRequestsQuery,
} from "./types.js";
import {
  buildApiUrl,
  createGitLabAllowlist,
  encodeProjectId,
  type GitLabAllowlist,
  type QueryValue,
} from "./url.js";

export interface GitLabReadClient {
  getCurrentUser(options?: { signal?: AbortSignal }): Promise<GitLabUser>;

  listAccessibleProjects(options?: ListOptions): Promise<Page<GitLabProjectRef>>;

  getProject(
    projectId: number | string,
    options?: { signal?: AbortSignal },
  ): Promise<GitLabProjectRef>;

  listBranches(
    projectId: number | string,
    options?: ListOptions,
  ): Promise<Page<GitLabBranchRef>>;

  listCommits(
    projectId: number | string,
    query: ListCommitsQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Page<GitLabCommit>>;

  listMergeRequests(
    projectId: number | string,
    query: ListMergeRequestsQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Page<GitLabMergeRequest>>;

  /** M2 workspace listing — live filters, no sync watermark required. */
  listProjectMergeRequests(
    projectId: number | string,
    query?: ListProjectMergeRequestsQuery,
    options?: { signal?: AbortSignal },
  ): Promise<Page<GitLabMergeRequest>>;

  getMergeRequest(
    projectId: number | string,
    iid: number,
    options?: { signal?: AbortSignal },
  ): Promise<GitLabMergeRequestDetail>;

  listMergeRequestDiffs(
    projectId: number | string,
    iid: number,
    options?: ListOptions,
  ): Promise<Page<GitLabMergeRequestDiff>>;

  getMergeRequestApprovals(
    projectId: number | string,
    iid: number,
    options?: { signal?: AbortSignal },
  ): Promise<GitLabMergeRequestApprovals>;

  listMergeRequestPipelines(
    projectId: number | string,
    iid: number,
    options?: ListOptions,
  ): Promise<Page<GitLabPipelineSummary>>;

  readonly limits: ClientLimits;
}

export type GitLabReadClientDeps = {
  readonly instance: GitLabInstanceContext;
  readonly auth: GitLabAuthAdapter;
  /** Defaults to an allowlist holding just this instance's origin (public). */
  readonly ssrf?: SsrfGuard;
  readonly allowlist?: GitLabAllowlist;
  readonly transport?: GitLabHttpTransport;
  readonly limits?: Partial<ClientLimits>;
  readonly sleep?: SleepFn;
  readonly random?: () => number;
};

export function createGitLabReadClient(
  deps: GitLabReadClientDeps,
): GitLabReadClient {
  const origin = deps.instance.baseUrlNormalized;
  if (typeof origin !== "string" || origin.length === 0) {
    throw new GitLabInvalidConfigError({ reason: "missing_base_url" });
  }

  const limits = resolveLimits(deps.limits);
  const ssrf =
    deps.ssrf ??
    createSsrfGuard({
      allowlist: deps.allowlist ?? createGitLabAllowlist([origin]),
    });

  const executor: GitLabRequestExecutor = createRequestExecutor({
    auth: deps.auth,
    ssrf,
    transport: deps.transport ?? createPinnedNodeTransport(),
    limits,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });

  async function get(
    path: string,
    query: Record<string, QueryValue>,
    scope: RouteScope,
    signal: AbortSignal | undefined,
  ): Promise<RawResponse> {
    const url = buildApiUrl(origin, path, query);
    return await executor.requestJson(url, {
      scope,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  function pageQuery(cursor: GitLabPageCursor | undefined): {
    page: number;
    per_page: number;
  } {
    return {
      page: cursor?.page ?? 1,
      per_page: cursor?.perPage ?? limits.perPage,
    };
  }

  function toPage<T>(
    response: RawResponse,
    cursor: GitLabPageCursor,
    map: (value: unknown) => T,
    what: string,
  ): Page<T> {
    const items = asArray(response.json, what).map(map);
    return {
      items,
      nextPage: parseNextCursor({
        headers: response.headers,
        expectedOrigin: origin,
        current: cursor,
      }),
    };
  }

  return {
    limits,

    async getCurrentUser(options): Promise<GitLabUser> {
      const response = await get("/api/v4/user", {}, "global", options?.signal);
      return mapUser(response.json);
    },

    async listAccessibleProjects(
      options,
    ): Promise<Page<GitLabProjectRef>> {
      const cursor: GitLabPageCursor = {
        page: options?.page?.page ?? 1,
        perPage: options?.page?.perPage ?? limits.perPage,
      };
      const response = await get(
        "/api/v4/projects",
        {
          membership: true,
          simple: true,
          order_by: "last_activity_at",
          ...pageQuery(options?.page),
        },
        "global",
        options?.signal,
      );
      return toPage(response, cursor, mapProject, "projects");
    },

    async getProject(projectId, options): Promise<GitLabProjectRef> {
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}`,
        {},
        "project",
        options?.signal,
      );
      return mapProject(response.json);
    },

    async listBranches(projectId, options): Promise<Page<GitLabBranchRef>> {
      const cursor: GitLabPageCursor = {
        page: options?.page?.page ?? 1,
        perPage: options?.page?.perPage ?? limits.perPage,
      };
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/repository/branches`,
        pageQuery(options?.page),
        "project",
        options?.signal,
      );
      return toPage(response, cursor, mapBranch, "branches");
    },

    async listCommits(projectId, query, options): Promise<Page<GitLabCommit>> {
      const cursor: GitLabPageCursor = {
        page: query.page?.page ?? 1,
        perPage: query.page?.perPage ?? limits.perPage,
      };
      // Commits filter on authored time only. `updated_after` is deliberately
      // absent here — it belongs to merge requests (D5).
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/repository/commits`,
        {
          since: toIsoInstant(query.since, "since"),
          until: toIsoInstant(query.until, "until"),
          ...(query.refName === undefined ? {} : { ref_name: query.refName }),
          ...pageQuery(query.page),
        },
        "project",
        options?.signal,
      );
      return toPage(response, cursor, mapCommit, "commits");
    },

    async listMergeRequests(
      projectId,
      query,
      options,
    ): Promise<Page<GitLabMergeRequest>> {
      const cursor: GitLabPageCursor = {
        page: query.page?.page ?? 1,
        perPage: query.page?.perPage ?? limits.perPage,
      };
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests`,
        {
          updated_after: toIsoInstant(query.updatedAfter, "updatedAfter"),
          ...(query.state === undefined ? {} : { state: query.state }),
          order_by: "updated_at",
          sort: "asc",
          ...pageQuery(query.page),
        },
        "project",
        options?.signal,
      );
      return toPage(response, cursor, mapMergeRequest, "merge_requests");
    },

    async listProjectMergeRequests(
      projectId,
      query = {},
      options,
    ): Promise<Page<GitLabMergeRequest>> {
      const cursor: GitLabPageCursor = {
        page: query.page?.page ?? 1,
        perPage: query.page?.perPage ?? limits.perPage,
      };
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests`,
        {
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.authorUsername === undefined
            ? {}
            : { author_username: query.authorUsername }),
          ...(query.reviewerUsername === undefined
            ? {}
            : { reviewer_username: query.reviewerUsername }),
          order_by: "updated_at",
          sort: "desc",
          ...pageQuery(query.page),
        },
        "project",
        options?.signal,
      );
      return toPage(response, cursor, mapMergeRequest, "merge_requests");
    },

    async getMergeRequest(
      projectId,
      iid,
      options,
    ): Promise<GitLabMergeRequestDetail> {
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}`,
        {},
        "project",
        options?.signal,
      );
      return mapMergeRequestDetail(response.json);
    },

    async listMergeRequestDiffs(
      projectId,
      iid,
      options,
    ): Promise<Page<GitLabMergeRequestDiff>> {
      const cursor: GitLabPageCursor = {
        page: options?.page?.page ?? 1,
        perPage: options?.page?.perPage ?? limits.perPage,
      };
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}/diffs`,
        pageQuery(options?.page),
        "project",
        options?.signal,
      );
      return toPage(response, cursor, mapMergeRequestDiff, "merge_request_diffs");
    },

    async getMergeRequestApprovals(
      projectId,
      iid,
      options,
    ): Promise<GitLabMergeRequestApprovals> {
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}/approvals`,
        {},
        "project",
        options?.signal,
      );
      return mapMergeRequestApprovals(response.json);
    },

    async listMergeRequestPipelines(
      projectId,
      iid,
      options,
    ): Promise<Page<GitLabPipelineSummary>> {
      const cursor: GitLabPageCursor = {
        page: options?.page?.page ?? 1,
        perPage: options?.page?.perPage ?? limits.perPage,
      };
      const response = await get(
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}/pipelines`,
        pageQuery(options?.page),
        "project",
        options?.signal,
      );
      return toPage(response, cursor, mapPipelineSummary, "pipelines");
    },
  };
}

function toIsoInstant(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new GitLabInvalidConfigError({ reason: "invalid_date", field });
  }
  return value.toISOString();
}
