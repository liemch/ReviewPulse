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
  };
}
