/**
 * WP2 — GitLab HTTP client with SSRF-hardened egress.
 *
 * Read surface (`createGitLabReadClient`) is GET-only. Write surface
 * (`createGitLabWriteClient`) is M2-only and always uses the caller-supplied
 * acting-user credential — never a shared/admin fallback.
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
  createGitLabWriteClient,
  type ApproveMergeRequestInput,
  type CreateMergeRequestNoteInput,
  type GitLabWriteClient,
  type GitLabWriteClientDeps,
  type MergeMergeRequestInput,
} from "./write-client.js";
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
  GitLabMergeRequestApprovals,
  GitLabMergeRequestDetail,
  GitLabMergeRequestDiff,
  GitLabMergeRequestState,
  GitLabPipelineSummary,
  GitLabProjectRef,
  GitLabUser,
  ListCommitsQuery,
  ListMergeRequestsQuery,
  ListOptions,
  ListProjectMergeRequestsQuery,
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
