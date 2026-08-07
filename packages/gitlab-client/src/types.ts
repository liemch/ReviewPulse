/** Public DTOs. Unknown GitLab fields are dropped rather than passed through. */

import type { GitLabPageCursor } from "./pagination.js";

export type GitLabInstanceContext = {
  /** ReviewPulse allowlist row id or another stable key. Never a secret. */
  readonly instanceId: string;
  /** Canonical origin from `normalizeGitLabBaseUrl`. */
  readonly baseUrlNormalized: string;
};

export type GitLabUser = {
  readonly id: number;
  readonly username: string;
  readonly name: string | null;
  readonly email: string | null;
};

export type GitLabProjectRef = {
  readonly id: number;
  readonly pathWithNamespace: string;
  readonly name: string;
  readonly archived: boolean;
  readonly defaultBranch: string | null;
  readonly webUrl: string | null;
  readonly lastActivityAt: string | null;
};

export type GitLabBranchRef = {
  readonly name: string;
  readonly merged: boolean;
  readonly protected: boolean;
  readonly default: boolean;
};

export type GitLabCommit = {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly message: string;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authoredDate: string;
  readonly webUrl: string | null;
};

export type GitLabMergeRequestState = "opened" | "closed" | "merged" | "all";

export type GitLabMergeRequest = {
  readonly iid: number;
  readonly projectId: number;
  readonly title: string;
  readonly state: string;
  readonly authorUsername: string | null;
  readonly authorEmail: string | null;
  readonly updatedAt: string;
  readonly webUrl: string | null;
  readonly sha: string | null;
  readonly reviewers: readonly string[];
};

/** Live MR detail for the workspace (not the sync list row). */
export type GitLabMergeRequestDetail = GitLabMergeRequest & {
  readonly description: string | null;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly draft: boolean;
  readonly hasConflicts: boolean;
  readonly mergeStatus: string | null;
  readonly detailedMergeStatus: string | null;
  readonly mergeable: boolean | null;
  /** Acting user's merge permission as reported by GitLab on the MR payload. */
  readonly userCanMerge: boolean | null;
  readonly labels: readonly string[];
  readonly createdAt: string | null;
};

export type GitLabMergeRequestDiff = {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly aMode: string | null;
  readonly bMode: string | null;
  readonly newFile: boolean;
  readonly renamedFile: boolean;
  readonly deletedFile: boolean;
  readonly diff: string;
};

export type GitLabMergeRequestApprovals = {
  readonly approved: boolean;
  readonly approvalsRequired: number | null;
  readonly approvalsLeft: number | null;
  readonly approvedBy: readonly string[];
  readonly userHasApproved: boolean;
  readonly userCanApprove: boolean;
};

export type GitLabPipelineSummary = {
  readonly id: number;
  readonly status: string;
  readonly ref: string | null;
  readonly sha: string | null;
  readonly webUrl: string | null;
  readonly updatedAt: string | null;
};

/**
 * Commits filter on authored time. Kept structurally distinct from the MR
 * query so a watermark meant for one can never be passed to the other (D5).
 */
export type ListCommitsQuery = {
  readonly since: Date;
  readonly until: Date;
  readonly refName?: string;
  readonly page?: GitLabPageCursor;
};

/** Merge requests filter on `updated_after`, never on since/until (D5). */
export type ListMergeRequestsQuery = {
  readonly updatedAfter: Date;
  readonly state?: GitLabMergeRequestState;
  readonly page?: GitLabPageCursor;
};

/** M2 workspace listing filters (live, authz-scoped per project). */
export type ListProjectMergeRequestsQuery = {
  readonly state?: GitLabMergeRequestState;
  readonly authorUsername?: string;
  readonly reviewerUsername?: string;
  readonly page?: GitLabPageCursor;
};

export type ListOptions = {
  readonly page?: GitLabPageCursor;
  readonly signal?: AbortSignal;
};
