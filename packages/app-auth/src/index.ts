/**
 * WP3 — AppAuth: local accounts, Argon2id, sessions, CSRF, lockout, audit.
 */

export { AuditWriter, type AuditAction } from "./audit.js";
export {
  assertCsrf,
  assertOrigin,
  issueCsrfToken,
} from "./csrf.js";
export { normalizeEmail } from "./email.js";
export {
  AccountDeactivatedError,
  AccountLockedError,
  AppAuthError,
  ConflictError,
  CsrfError,
  ForbiddenError,
  InvalidCredentialsError,
  InvalidInputError,
  isAppAuthError,
  NotFoundError,
  OriginError,
  RateLimitedError,
  SessionExpiredError,
  UnauthorizedError,
  type AppAuthErrorCode,
} from "./errors.js";
export {
  LocalPasswordAuthProvider,
  type AppAuthProvider,
  type AppUser,
  type LocalPasswordAuthDeps,
  type LoginResult,
} from "./local-password-provider.js";
export { LockoutService } from "./lockout.js";
export {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password.js";
export {
  csrfTokensEqual,
  hashFingerprint,
  hashSessionToken,
  loadSessionPolicy,
  mintCsrfToken,
  mintSessionToken,
  SESSION_ABS_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  type SessionPolicy,
} from "./session-crypto.js";
export {
  SessionService,
  type AuthUser,
  type CreateSessionInput,
  type SessionRecord,
  type ValidatedSession,
} from "./session-service.js";
export { UserAdminService } from "./user-admin.js";

export const PACKAGE_NAME = "@reviewpulse/app-auth" as const;
