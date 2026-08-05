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

export type ListOptions = {
  readonly page?: GitLabPageCursor;
  readonly signal?: AbortSignal;
};
