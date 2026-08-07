/**
 * M2 MR mutations — comment / approve / merge with acting-user credential only.
 *
 * Security invariants:
 * - PAT is always resolved from the acting user's connection (no admin/shared
 *   fallback; never act as another user).
 * - Authz re-checked via MrWorkspaceService before every mutation.
 * - Merge blocked by evaluateMergeSafety + live GitLab denial.
 * - Audit never receives PAT, Authorization headers, or full diff.
 */

import type { PrismaClient } from "@reviewpulse/db";
import type { PatCredentialProvider } from "@reviewpulse/credentials";
import {
  createGitLabAllowlist,
  createGitLabWriteClient,
  createPatAuthAdapter,
  createSsrfGuard,
  GitLabForbiddenError,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabRateLimitedError,
  GitLabUnauthorizedError,
  GitLabUnexpectedStatusError,
  isGitLabError,
  type GitLabWriteClient,
} from "@reviewpulse/gitlab-client";

import { ConnectionPolicyError } from "./gitlab-connection.js";
import {
  evaluateMergeSafety,
  isApprovalsSatisfied,
  isPipelineStatusOk,
  isStaleReview,
  type MergeSafetyBlockReason,
} from "./merge-safety.js";
import { MrWorkspaceService } from "./mr-workspace.js";
import type { LiveProjectAccessService } from "./project-access.js";

export type MrMutationRef = {
  readonly gitlabInstanceId: string;
  readonly gitlabProjectId: string;
  readonly iid: number;
};

export type MrMutationAuditWriter = {
  write(
    action: "mr_comment" | "mr_approve" | "mr_merge",
    actorUserId: string | null,
    meta: Record<string, unknown>,
  ): Promise<void>;
};

export type MrMutationResult =
  | {
      readonly ok: true;
      readonly headSha: string | null;
      readonly afterSha?: string | null;
    }
  | {
      readonly ok: false;
      readonly error:
        | "not_found"
        | "stale_sha"
        | "not_confirmed"
        | "merge_blocked"
        | "unauthorized_credential"
        | "forbidden"
        | "conflict"
        | "rate_limited"
        | "upstream"
        | "invalid_input";
      readonly reasons?: readonly MergeSafetyBlockReason[];
      readonly category?: string;
    };

export class MrMutationService {
  readonly workspace: MrWorkspaceService;

  constructor(
    private readonly prisma: PrismaClient,
    projects: LiveProjectAccessService,
    private readonly credentials: PatCredentialProvider,
    private readonly audit: MrMutationAuditWriter,
  ) {
    this.workspace = new MrWorkspaceService(prisma, projects, credentials);
  }

  async comment(
    userId: string,
    ref: MrMutationRef,
    body: string,
  ): Promise<MrMutationResult> {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: "invalid_input" };
    }

    const detail = await this.workspace.getDetail(userId, ref);
    if ("kind" in detail) {
      await this.safeAudit("mr_comment", userId, ref, {
        result: "failure",
        category: "not_found",
      });
      return { ok: false, error: "not_found" };
    }

    const headSha = detail.mr.sha;
    try {
      const client = await this.actingWriteClient(userId, ref.gitlabInstanceId);
      await client.createMergeRequestNote(ref.gitlabProjectId, ref.iid, {
        body: trimmed,
      });
      await this.safeAudit("mr_comment", userId, ref, {
        result: "success",
        headSha,
      });
      return { ok: true, headSha };
    } catch (error) {
      return await this.mapMutationError("mr_comment", userId, ref, headSha, error);
    }
  }

  async approve(
    userId: string,
    ref: MrMutationRef,
    input: { reviewedHeadSha: string; confirmed: boolean },
  ): Promise<MrMutationResult> {
    if (!input.confirmed) {
      return { ok: false, error: "not_confirmed" };
    }

    const detail = await this.workspace.getDetail(userId, ref);
    if ("kind" in detail) {
      await this.safeAudit("mr_approve", userId, ref, {
        result: "failure",
        category: "not_found",
      });
      return { ok: false, error: "not_found" };
    }

    const currentHeadSha = detail.mr.sha;
    if (isStaleReview(input.reviewedHeadSha, currentHeadSha)) {
      await this.safeAudit("mr_approve", userId, ref, {
        result: "failure",
        category: "stale_sha",
        reviewedHeadSha: input.reviewedHeadSha,
        currentHeadSha,
      });
      return { ok: false, error: "stale_sha" };
    }

    try {
      const client = await this.actingWriteClient(userId, ref.gitlabInstanceId);
      await client.approveMergeRequest(ref.gitlabProjectId, ref.iid, {
        ...(currentHeadSha === null ? {} : { sha: currentHeadSha }),
      });
      await this.safeAudit("mr_approve", userId, ref, {
        result: "success",
        headSha: currentHeadSha,
      });
      return { ok: true, headSha: currentHeadSha };
    } catch (error) {
      return await this.mapMutationError(
        "mr_approve",
        userId,
        ref,
        currentHeadSha,
        error,
      );
    }
  }

  async merge(
    userId: string,
    ref: MrMutationRef,
    input: {
      reviewedHeadSha: string;
      confirmed: boolean;
    },
  ): Promise<MrMutationResult> {
    if (!input.confirmed) {
      return { ok: false, error: "not_confirmed" };
    }

    const detail = await this.workspace.getDetail(userId, ref);
    if ("kind" in detail) {
      await this.safeAudit("mr_merge", userId, ref, {
        result: "failure",
        category: "not_found",
      });
      return { ok: false, error: "not_found" };
    }

    const currentHeadSha = detail.mr.sha;
    const latestPipeline = detail.pipelines[0] ?? null;
    const pipelineOk = isPipelineStatusOk(
      latestPipeline?.status,
      /* allowMissing */ true,
    );
    const approvalsSatisfied = isApprovalsSatisfied({
      approvalsRequired: detail.approvals?.approvalsRequired ?? null,
      approvalsLeft: detail.approvals?.approvalsLeft ?? null,
      approved: detail.approvals?.approved ?? false,
    });

    // Prefer GitLab's mergeable + user.can_merge; never invent permission.
    const userCanMerge =
      detail.mr.userCanMerge === true &&
      detail.mr.mergeable !== false &&
      detail.mr.state === "opened";

    const safety = evaluateMergeSafety({
      userCanMerge,
      reviewedHeadSha: input.reviewedHeadSha,
      currentHeadSha,
      hasConflicts: detail.mr.hasConflicts,
      pipelineOk,
      approvalsSatisfied,
      draft: detail.mr.draft,
      confirmed: input.confirmed,
    });

    if (!safety.allowed) {
      await this.safeAudit("mr_merge", userId, ref, {
        result: "failure",
        category: "merge_blocked",
        reasons: [...safety.reasons],
        reviewedHeadSha: input.reviewedHeadSha,
        currentHeadSha,
      });
      return {
        ok: false,
        error: safety.reasons.includes("sha_mismatch")
          ? "stale_sha"
          : "merge_blocked",
        reasons: safety.reasons,
      };
    }

    if (currentHeadSha === null) {
      return { ok: false, error: "merge_blocked", reasons: ["sha_missing"] };
    }

    try {
      const client = await this.actingWriteClient(userId, ref.gitlabInstanceId);
      const merged = await client.mergeMergeRequest(
        ref.gitlabProjectId,
        ref.iid,
        { sha: currentHeadSha },
      );
      await this.safeAudit("mr_merge", userId, ref, {
        result: "success",
        headSha: currentHeadSha,
        afterSha: merged.sha,
      });
      return { ok: true, headSha: currentHeadSha, afterSha: merged.sha };
    } catch (error) {
      return await this.mapMutationError(
        "mr_merge",
        userId,
        ref,
        currentHeadSha,
        error,
      );
    }
  }

  /**
   * Resolves write client for the acting user only. No admin/shared fallback.
   */
  async actingWriteClient(
    userId: string,
    gitlabInstanceId: string,
  ): Promise<GitLabWriteClient> {
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
    return createGitLabWriteClient({
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

  private async mapMutationError(
    action: "mr_comment" | "mr_approve" | "mr_merge",
    userId: string,
    ref: MrMutationRef,
    headSha: string | null,
    error: unknown,
  ): Promise<MrMutationResult> {
    let result: MrMutationResult;
    let category: string;

    if (error instanceof ConnectionPolicyError) {
      category = "no_connection";
      result = { ok: false, error: "unauthorized_credential", category };
    } else if (error instanceof GitLabUnauthorizedError) {
      category = "gitlab_unauthorized";
      result = { ok: false, error: "unauthorized_credential", category };
    } else if (
      error instanceof GitLabForbiddenError ||
      error instanceof GitLabProjectForbiddenError
    ) {
      category = "gitlab_forbidden";
      result = { ok: false, error: "forbidden", category };
    } else if (error instanceof GitLabProjectNotFoundError) {
      category = "not_found";
      result = { ok: false, error: "not_found", category };
    } else if (
      error instanceof GitLabUnexpectedStatusError &&
      error.status === 409
    ) {
      category = "conflict";
      result = { ok: false, error: "conflict", category };
    } else if (error instanceof GitLabRateLimitedError) {
      category = "rate_limited";
      result = { ok: false, error: "rate_limited", category };
    } else if (isGitLabError(error)) {
      category = error.code;
      result = { ok: false, error: "upstream", category };
    } else {
      category = "unknown";
      result = { ok: false, error: "upstream", category };
    }

    await this.safeAudit(action, userId, ref, {
      result: "failure",
      category,
      headSha,
    });
    return result;
  }

  private async safeAudit(
    action: "mr_comment" | "mr_approve" | "mr_merge",
    actorUserId: string,
    ref: MrMutationRef,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write(action, actorUserId, {
      gitlabInstanceId: ref.gitlabInstanceId,
      gitlabProjectId: ref.gitlabProjectId,
      iid: ref.iid,
      ...meta,
    });
  }
}
