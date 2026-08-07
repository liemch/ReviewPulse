/**
 * M2 merge-safety predicates — pure, no I/O.
 *
 * GitLab remains source of truth; these gates block ReviewPulse from calling
 * merge when live state is unsafe. They never bypass protected-branch /
 * approval / pipeline rules on GitLab itself.
 */

export type MergeSafetyInput = {
  readonly userCanMerge: boolean;
  readonly reviewedHeadSha: string | null;
  readonly currentHeadSha: string | null;
  readonly hasConflicts: boolean;
  readonly pipelineOk: boolean;
  readonly approvalsSatisfied: boolean;
  readonly draft: boolean;
  readonly confirmed: boolean;
};

export type MergeSafetyBlockReason =
  | "permission_denied"
  | "sha_mismatch"
  | "sha_missing"
  | "conflicts"
  | "pipeline_unsatisfied"
  | "approvals_insufficient"
  | "draft"
  | "not_confirmed";

export type MergeSafetyResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reasons: readonly MergeSafetyBlockReason[] };

export function evaluateMergeSafety(input: MergeSafetyInput): MergeSafetyResult {
  const reasons: MergeSafetyBlockReason[] = [];

  if (!input.userCanMerge) {
    reasons.push("permission_denied");
  }

  if (
    input.reviewedHeadSha === null ||
    input.reviewedHeadSha.length === 0 ||
    input.currentHeadSha === null ||
    input.currentHeadSha.length === 0
  ) {
    reasons.push("sha_missing");
  } else if (input.reviewedHeadSha !== input.currentHeadSha) {
    reasons.push("sha_mismatch");
  }

  if (input.hasConflicts) {
    reasons.push("conflicts");
  }

  if (!input.pipelineOk) {
    reasons.push("pipeline_unsatisfied");
  }

  if (!input.approvalsSatisfied) {
    reasons.push("approvals_insufficient");
  }

  if (input.draft) {
    reasons.push("draft");
  }

  if (!input.confirmed) {
    reasons.push("not_confirmed");
  }

  if (reasons.length > 0) {
    return { allowed: false, reasons };
  }
  return { allowed: true };
}

/** Pipeline statuses that satisfy merge-when-pipeline-must-succeed style gates. */
const PIPELINE_OK = new Set([
  "success",
  "skipped",
  "manual",
  "not_required",
]);

export function isPipelineStatusOk(
  status: string | null | undefined,
  /** When GitLab reports no pipeline and project does not require one. */
  allowMissing = true,
): boolean {
  if (status === null || status === undefined || status.length === 0) {
    return allowMissing;
  }
  return PIPELINE_OK.has(status.toLowerCase());
}

export function isApprovalsSatisfied(input: {
  readonly approvalsRequired: number | null;
  readonly approvalsLeft: number | null;
  readonly approved: boolean;
}): boolean {
  if (input.approved) {
    return true;
  }
  if (input.approvalsRequired === null || input.approvalsRequired === 0) {
    return true;
  }
  if (input.approvalsLeft === null) {
    return false;
  }
  return input.approvalsLeft <= 0;
}

export function isStaleReview(
  reviewedHeadSha: string | null,
  currentHeadSha: string | null,
): boolean {
  if (
    reviewedHeadSha === null ||
    reviewedHeadSha.length === 0 ||
    currentHeadSha === null ||
    currentHeadSha.length === 0
  ) {
    return true;
  }
  return reviewedHeadSha !== currentHeadSha;
}
