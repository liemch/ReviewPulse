/**
 * GitLab write client — M2 mutations (comment / approve / merge).
 *
 * Always uses the credential supplied via `auth` (acting user). There is no
 * admin/shared fallback path in this module.
 */

import type { GitLabAuthAdapter } from "./auth.js";
import { GitLabInvalidConfigError } from "./errors.js";
import {
  createRequestExecutor,
  type GitLabRequestExecutor,
  type SleepFn,
} from "./http.js";
import { resolveLimits, type ClientLimits } from "./limits.js";
import { mapMergeRequestDetail } from "./mappers.js";
import { createSsrfGuard, type SsrfGuard } from "./ssrf.js";
import {
  createPinnedNodeTransport,
  type GitLabHttpTransport,
} from "./transport.js";
import type {
  GitLabInstanceContext,
  GitLabMergeRequestDetail,
} from "./types.js";
import {
  buildApiUrl,
  createGitLabAllowlist,
  encodeProjectId,
  type GitLabAllowlist,
} from "./url.js";

export type CreateMergeRequestNoteInput = {
  readonly body: string;
};

export type ApproveMergeRequestInput = {
  readonly sha?: string;
};

export type MergeMergeRequestInput = {
  readonly sha: string;
  readonly shouldRemoveSourceBranch?: boolean;
  readonly mergeWhenPipelineSucceeds?: boolean;
};

export interface GitLabWriteClient {
  createMergeRequestNote(
    projectId: number | string,
    iid: number,
    input: CreateMergeRequestNoteInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ id: number }>;

  approveMergeRequest(
    projectId: number | string,
    iid: number,
    input?: ApproveMergeRequestInput,
    options?: { signal?: AbortSignal },
  ): Promise<void>;

  mergeMergeRequest(
    projectId: number | string,
    iid: number,
    input: MergeMergeRequestInput,
    options?: { signal?: AbortSignal },
  ): Promise<GitLabMergeRequestDetail>;

  readonly limits: ClientLimits;
}

export type GitLabWriteClientDeps = {
  readonly instance: GitLabInstanceContext;
  readonly auth: GitLabAuthAdapter;
  readonly ssrf?: SsrfGuard;
  readonly allowlist?: GitLabAllowlist;
  readonly transport?: GitLabHttpTransport;
  readonly limits?: Partial<ClientLimits>;
  readonly sleep?: SleepFn;
  readonly random?: () => number;
};

export function createGitLabWriteClient(
  deps: GitLabWriteClientDeps,
): GitLabWriteClient {
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

  return {
    limits,

    async createMergeRequestNote(projectId, iid, input, options) {
      const body = input.body.trim();
      if (body.length === 0) {
        throw new GitLabInvalidConfigError({
          reason: "empty_note_body",
          field: "body",
        });
      }
      const url = buildApiUrl(
        origin,
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}/notes`,
        {},
      );
      const response = await executor.requestMutationJson(url, {
        scope: "project",
        method: "POST",
        body: { body },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const json = response.json;
      if (
        typeof json !== "object" ||
        json === null ||
        typeof (json as { id?: unknown }).id !== "number"
      ) {
        return { id: 0 };
      }
      return { id: (json as { id: number }).id };
    },

    async approveMergeRequest(projectId, iid, input = {}, options) {
      const url = buildApiUrl(
        origin,
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}/approve`,
        {},
      );
      await executor.requestMutationJson(url, {
        scope: "project",
        method: "POST",
        body: input.sha === undefined ? {} : { sha: input.sha },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    },

    async mergeMergeRequest(projectId, iid, input, options) {
      const url = buildApiUrl(
        origin,
        `/api/v4/projects/${encodeProjectId(projectId)}/merge_requests/${iid}/merge`,
        {},
      );
      const response = await executor.requestMutationJson(url, {
        scope: "project",
        method: "PUT",
        body: {
          sha: input.sha,
          ...(input.shouldRemoveSourceBranch === undefined
            ? {}
            : {
                should_remove_source_branch: input.shouldRemoveSourceBranch,
              }),
          ...(input.mergeWhenPipelineSucceeds === undefined
            ? {}
            : {
                merge_when_pipeline_succeeds: input.mergeWhenPipelineSucceeds,
              }),
        },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return mapMergeRequestDetail(response.json);
    },
  };
}
