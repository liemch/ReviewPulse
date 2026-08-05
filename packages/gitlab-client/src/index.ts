/**
 * WP2 — GitLab read-only HTTP client with SSRF-hardened egress.
 *
 * M1 is read-only: nothing exported here can issue a POST/PUT/PATCH/DELETE,
 * and `readonly.test.ts` fails the build if that stops being true.
 */

export {
  createPatAuthAdapter,
  PRIVATE_TOKEN_HEADER,
  type GitLabAccessToken,
  type GitLabAuthAdapter,
  type GitLabCredential,
  type TokenProvider,
} from "./auth.js";
export {
  createGitLabReadClient,
  type GitLabReadClient,
  type GitLabReadClientDeps,
} from "./client.js";
export {
  GITLAB_ERROR_CODES,
  GitLabAbortedError,
  GitLabError,
  GitLabForbiddenError,
  GitLabInvalidConfigError,
  GitLabMalformedResponseError,
  GitLabNotFoundError,
  GitLabPaginationLimitError,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabRateLimitedError,
  GitLabRedirectRejectedError,
  GitLabResponseTooLargeError,
  GitLabSsrfBlockedError,
  GitLabTimeoutError,
  GitLabUnauthorizedError,
  GitLabUnexpectedStatusError,
  GitLabUpstreamUnavailableError,
  isGitLabError,
  type GitLabErrorCode,
} from "./errors.js";
export {
  defaultSleep,
  parseRetryAfter,
  USER_AGENT,
  type RouteScope,
  type SleepFn,
} from "./http.js";
export {
  classifyIpAddress,
  isIpLiteral,
  type IpCategory,
  type IpClassification,
} from "./ip.js";
export { DEFAULT_LIMITS, resolveLimits, type ClientLimits } from "./limits.js";
export {
  drainPages,
  parseLinkHeader,
  parseNextCursor,
  type GitLabPageCursor,
  type Page,
  type PaginationBounds,
} from "./pagination.js";
export {
  createSsrfGuard,
  defaultDnsResolver,
  type DnsResolver,
  type ResolvedAddress,
  type SsrfDecision,
  type SsrfGuard,
} from "./ssrf.js";
export {
  createPinnedNodeTransport,
  type GitLabHttpRequest,
  type GitLabHttpResponse,
  type GitLabHttpTransport,
} from "./transport.js";
export type {
  GitLabBranchRef,
  GitLabCommit,
  GitLabInstanceContext,
  GitLabMergeRequest,
  GitLabMergeRequestState,
  GitLabProjectRef,
  GitLabUser,
  ListCommitsQuery,
  ListMergeRequestsQuery,
  ListOptions,
} from "./types.js";
export {
  buildApiUrl,
  createGitLabAllowlist,
  encodeProjectId,
  normalizeGitLabBaseUrl,
  originOf,
  parseAllowlistEnv,
  type GitLabAllowlist,
  type GitLabAllowlistEntry,
  type NormalizeOptions,
  type QueryValue,
} from "./url.js";

export const PACKAGE_NAME = "@reviewpulse/gitlab-client" as const;
