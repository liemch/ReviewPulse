/**
 * GitLab JSON -> DTO mapping.
 *
 * Required fields are validated rather than cast: a response missing a commit
 * SHA is a malformed response, not a record with `undefined` that blows up
 * three layers later in the sync worker.
 */

import { GitLabMalformedResponseError } from "./errors.js";
import type {
  GitLabBranchRef,
  GitLabCommit,
  GitLabMergeRequest,
  GitLabMergeRequestApprovals,
  GitLabMergeRequestDetail,
  GitLabMergeRequestDiff,
  GitLabPipelineSummary,
  GitLabProjectRef,
  GitLabUser,
} from "./types.js";

type Json = Record<string, unknown>;

function asObject(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitLabMalformedResponseError({ reason: "not_an_object", what });
  }
  return value as Json;
}

export function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new GitLabMalformedResponseError({ reason: "not_an_array", what });
  }
  return value;
}

function requireString(source: Json, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new GitLabMalformedResponseError({
      reason: "missing_string_field",
      what,
      field: key,
    });
  }
  return value;
}

function optionalString(source: Json, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireInt(source: Json, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GitLabMalformedResponseError({
      reason: "missing_integer_field",
      what,
      field: key,
    });
  }
  return value;
}

function optionalBool(source: Json, key: string): boolean {
  return source[key] === true;
}

export function mapUser(value: unknown): GitLabUser {
  const source = asObject(value, "user");
  return {
    id: requireInt(source, "id", "user"),
    username: requireString(source, "username", "user"),
    name: optionalString(source, "name"),
    email: optionalString(source, "email"),
  };
}

export function mapProject(value: unknown): GitLabProjectRef {
  const source = asObject(value, "project");
  return {
    id: requireInt(source, "id", "project"),
    pathWithNamespace: requireString(
      source,
      "path_with_namespace",
      "project",
    ),
    name: requireString(source, "name", "project"),
    archived: optionalBool(source, "archived"),
    defaultBranch: optionalString(source, "default_branch"),
    webUrl: optionalString(source, "web_url"),
    lastActivityAt: optionalString(source, "last_activity_at"),
  };
}

export function mapBranch(value: unknown): GitLabBranchRef {
  const source = asObject(value, "branch");
  return {
    name: requireString(source, "name", "branch"),
    merged: optionalBool(source, "merged"),
    protected: optionalBool(source, "protected"),
    default: optionalBool(source, "default"),
  };
}

export function mapCommit(value: unknown): GitLabCommit {
  const source = asObject(value, "commit");
  return {
    id: requireString(source, "id", "commit"),
    shortId: optionalString(source, "short_id") ?? "",
    title: optionalString(source, "title") ?? "",
    message: optionalString(source, "message") ?? "",
    authorName: optionalString(source, "author_name"),
    authorEmail: optionalString(source, "author_email"),
    authoredDate: requireString(source, "authored_date", "commit"),
    webUrl: optionalString(source, "web_url"),
  };
}

function mapUsernames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(entry);
      continue;
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const username = optionalString(entry as Json, "username");
      if (username !== null) {
        out.push(username);
      }
    }
  }
  return out;
}

function mapLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      out.push(entry);
      continue;
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const name = optionalString(entry as Json, "name");
      if (name !== null) {
        out.push(name);
      }
    }
  }
  return out;
}

export function mapMergeRequest(value: unknown): GitLabMergeRequest {
  const source = asObject(value, "merge_request");
  const author = source["author"];
  const authorObject =
    typeof author === "object" && author !== null && !Array.isArray(author)
      ? (author as Json)
      : null;

  return {
    iid: requireInt(source, "iid", "merge_request"),
    projectId: requireInt(source, "project_id", "merge_request"),
    title: optionalString(source, "title") ?? "",
    state: requireString(source, "state", "merge_request"),
    authorUsername:
      authorObject === null ? null : optionalString(authorObject, "username"),
    // GitLab omits author email on MR payloads for most token scopes.
    authorEmail:
      authorObject === null ? null : optionalString(authorObject, "email"),
    updatedAt: requireString(source, "updated_at", "merge_request"),
    webUrl: optionalString(source, "web_url"),
    sha: optionalString(source, "sha"),
    reviewers: mapUsernames(source["reviewers"]),
  };
}

export function mapMergeRequestDetail(value: unknown): GitLabMergeRequestDetail {
  const base = mapMergeRequest(value);
  const source = asObject(value, "merge_request_detail");
  const draft =
    optionalBool(source, "draft") === true ||
    optionalBool(source, "work_in_progress") === true;
  const mergeableRaw = source["mergeable"];
  const mergeable =
    typeof mergeableRaw === "boolean" ? mergeableRaw : null;

  const userBlock = source["user"];
  let userCanMerge: boolean | null = null;
  if (
    typeof userBlock === "object" &&
    userBlock !== null &&
    !Array.isArray(userBlock)
  ) {
    const canMerge = (userBlock as Json)["can_merge"];
    if (typeof canMerge === "boolean") {
      userCanMerge = canMerge;
    }
  }

  return {
    ...base,
    description: optionalString(source, "description"),
    sourceBranch: requireString(source, "source_branch", "merge_request_detail"),
    targetBranch: requireString(source, "target_branch", "merge_request_detail"),
    draft,
    hasConflicts: optionalBool(source, "has_conflicts") === true,
    mergeStatus: optionalString(source, "merge_status"),
    detailedMergeStatus: optionalString(source, "detailed_merge_status"),
    mergeable,
    userCanMerge,
    labels: mapLabels(source["labels"]),
    createdAt: optionalString(source, "created_at"),
  };
}

export function mapMergeRequestDiff(value: unknown): GitLabMergeRequestDiff {
  const source = asObject(value, "merge_request_diff");
  return {
    oldPath: optionalString(source, "old_path"),
    newPath: optionalString(source, "new_path"),
    aMode: optionalString(source, "a_mode"),
    bMode: optionalString(source, "b_mode"),
    newFile: optionalBool(source, "new_file") === true,
    renamedFile: optionalBool(source, "renamed_file") === true,
    deletedFile: optionalBool(source, "deleted_file") === true,
    // Diff text is returned to the caller for display only; never persist/log.
    diff: typeof source["diff"] === "string" ? source["diff"] : "",
  };
}

export function mapMergeRequestApprovals(
  value: unknown,
): GitLabMergeRequestApprovals {
  const source = asObject(value, "merge_request_approvals");
  const approvedByRaw = source["approved_by"];
  const approvedBy: string[] = [];
  if (Array.isArray(approvedByRaw)) {
    for (const entry of approvedByRaw) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const user = (entry as Json)["user"];
        if (typeof user === "object" && user !== null && !Array.isArray(user)) {
          const username = optionalString(user as Json, "username");
          if (username !== null) {
            approvedBy.push(username);
          }
        }
      }
    }
  }

  const required = source["approvals_required"];
  const left = source["approvals_left"];

  return {
    approved: optionalBool(source, "approved") === true,
    approvalsRequired: typeof required === "number" ? required : null,
    approvalsLeft: typeof left === "number" ? left : null,
    approvedBy,
    userHasApproved: optionalBool(source, "user_has_approved") === true,
    userCanApprove: optionalBool(source, "user_can_approve") === true,
  };
}

export function mapPipelineSummary(value: unknown): GitLabPipelineSummary {
  const source = asObject(value, "pipeline");
  return {
    id: requireInt(source, "id", "pipeline"),
    status: requireString(source, "status", "pipeline"),
    ref: optionalString(source, "ref"),
    sha: optionalString(source, "sha"),
    webUrl: optionalString(source, "web_url"),
    updatedAt: optionalString(source, "updated_at"),
  };
}
