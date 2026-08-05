/**
 * WP2 error taxonomy.
 *
 * Every error carries a stable `code` and a fixed message. Messages are
 * constants so they can cross a trust boundary via `toSafeErrorPayload`
 * without ever embedding a PAT, a response body, or a resolved URL.
 *
 * Free-form detail goes into `context`, which is deep-redacted at construction
 * time — a caller that stuffs a token in there still cannot leak it.
 */

import { redact, type SafeDomainError } from "@reviewpulse/crypto";

export const GITLAB_ERROR_CODES = [
  "GITLAB_INVALID_CONFIG",
  "GITLAB_SSRF_BLOCKED",
  "GITLAB_REDIRECT_REJECTED",
  "GITLAB_UNAUTHORIZED",
  "GITLAB_FORBIDDEN",
  "GITLAB_NOT_FOUND",
  "GITLAB_PROJECT_FORBIDDEN",
  "GITLAB_PROJECT_NOT_FOUND",
  "GITLAB_RATE_LIMITED",
  "GITLAB_TIMEOUT",
  "GITLAB_ABORTED",
  "GITLAB_UPSTREAM_UNAVAILABLE",
  "GITLAB_MALFORMED_RESPONSE",
  "GITLAB_RESPONSE_TOO_LARGE",
  "GITLAB_PAGINATION_LIMIT",
  "GITLAB_UNEXPECTED_STATUS",
] as const;

export type GitLabErrorCode = (typeof GITLAB_ERROR_CODES)[number];

export abstract class GitLabError extends Error implements SafeDomainError {
  abstract readonly code: GitLabErrorCode;
  readonly safeForClient = true as const;
  readonly context: Record<string, unknown>;

  protected constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.context = (redact(context ?? {}) ?? {}) as Record<string, unknown>;
  }
}

export function isGitLabError(value: unknown): value is GitLabError {
  return value instanceof GitLabError;
}

/** Base URL / allowlist entry that cannot be normalized into a usable origin. */
export class GitLabInvalidConfigError extends GitLabError {
  readonly code = "GITLAB_INVALID_CONFIG" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab instance configuration is invalid", context);
  }
}

/** Allowlist miss, denied address class, DNS failure, or cross-origin hop. */
export class GitLabSsrfBlockedError extends GitLabError {
  readonly code = "GITLAB_SSRF_BLOCKED" as const;
  constructor(context?: Record<string, unknown>) {
    super("Request blocked by GitLab egress policy", context);
  }
}

/** Any 3xx. Redirects are never followed (A2). */
export class GitLabRedirectRejectedError extends GitLabError {
  readonly code = "GITLAB_REDIRECT_REJECTED" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab redirect rejected", context);
  }
}

/** HTTP 401 — the credential itself is not accepted. */
export class GitLabUnauthorizedError extends GitLabError {
  readonly code = "GITLAB_UNAUTHORIZED" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab credential is not authorized", context);
  }
}

/** HTTP 403 on a non-project route. */
export class GitLabForbiddenError extends GitLabError {
  readonly code = "GITLAB_FORBIDDEN" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab request forbidden", context);
  }
}

/** HTTP 404 on a non-project route. */
export class GitLabNotFoundError extends GitLabError {
  readonly code = "GITLAB_NOT_FOUND" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab resource not found", context);
  }
}

/**
 * HTTP 403 on a project-scoped route. Distinct from 401 (D4): the token is
 * valid, this one project is not visible to it.
 */
export class GitLabProjectForbiddenError extends GitLabError {
  readonly code = "GITLAB_PROJECT_FORBIDDEN" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab project access is forbidden", context);
  }
}

/** HTTP 404 on a project-scoped route (GitLab masks forbidden projects as 404). */
export class GitLabProjectNotFoundError extends GitLabError {
  readonly code = "GITLAB_PROJECT_NOT_FOUND" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab project was not found", context);
  }
}

/** 429 after the retry budget is spent. */
export class GitLabRateLimitedError extends GitLabError {
  readonly code = "GITLAB_RATE_LIMITED" as const;
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null, context?: Record<string, unknown>) {
    super("GitLab rate limit exceeded", context);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Per-attempt or total deadline elapsed. */
export class GitLabTimeoutError extends GitLabError {
  readonly code = "GITLAB_TIMEOUT" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab request timed out", context);
  }
}

/** The caller's AbortSignal fired. Never retried. */
export class GitLabAbortedError extends GitLabError {
  readonly code = "GITLAB_ABORTED" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab request was aborted", context);
  }
}

/** 5xx or transport failure after the retry budget is spent. */
export class GitLabUpstreamUnavailableError extends GitLabError {
  readonly code = "GITLAB_UPSTREAM_UNAVAILABLE" as const;
  readonly retryAfterMs: number | null;

  constructor(
    context?: Record<string, unknown>,
    retryAfterMs: number | null = null,
  ) {
    super("GitLab is unavailable", context);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A 4xx we have no specific meaning for (400, 422, ...). Never retried: the
 * request is wrong, so repeating it verbatim cannot help.
 */
export class GitLabUnexpectedStatusError extends GitLabError {
  readonly code = "GITLAB_UNEXPECTED_STATUS" as const;
  readonly status: number;

  constructor(status: number, context?: Record<string, unknown>) {
    super("GitLab returned an unexpected status", context);
    this.status = status;
  }
}

/** Non-JSON body, schema mismatch, or an unparseable pagination header. */
export class GitLabMalformedResponseError extends GitLabError {
  readonly code = "GITLAB_MALFORMED_RESPONSE" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab response was malformed", context);
  }
}

/** Body exceeded the per-page byte cap (A7). */
export class GitLabResponseTooLargeError extends GitLabError {
  readonly code = "GITLAB_RESPONSE_TOO_LARGE" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab response exceeded the size limit", context);
  }
}

/** maxPages / maxItems exceeded, or a repeated page cursor. */
export class GitLabPaginationLimitError extends GitLabError {
  readonly code = "GITLAB_PAGINATION_LIMIT" as const;
  constructor(context?: Record<string, unknown>) {
    super("GitLab pagination limit exceeded", context);
  }
}
