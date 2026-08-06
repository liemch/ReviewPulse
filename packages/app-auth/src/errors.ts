/**
 * WP3 AppAuth errors — fixed messages, redacted context, never passwords/tokens.
 */

import { redact, type SafeDomainError } from "@reviewpulse/crypto";

export type AppAuthErrorCode =
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_ACCOUNT_LOCKED"
  | "AUTH_ACCOUNT_DEACTIVATED"
  | "AUTH_FORBIDDEN"
  | "AUTH_UNAUTHORIZED"
  | "AUTH_INVALID_INPUT"
  | "AUTH_CSRF"
  | "AUTH_ORIGIN"
  | "AUTH_SESSION_EXPIRED"
  | "AUTH_CONFLICT"
  | "AUTH_NOT_FOUND"
  | "AUTH_RATE_LIMITED";

export abstract class AppAuthError extends Error implements SafeDomainError {
  abstract readonly code: AppAuthErrorCode;
  readonly safeForClient = true as const;
  readonly context: Record<string, unknown>;

  protected constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.context = (redact(context ?? {}) ?? {}) as Record<string, unknown>;
  }
}

export class InvalidCredentialsError extends AppAuthError {
  readonly code = "AUTH_INVALID_CREDENTIALS" as const;
  constructor(context?: Record<string, unknown>) {
    super("Invalid email or password", context);
  }
}

export class AccountLockedError extends AppAuthError {
  readonly code = "AUTH_ACCOUNT_LOCKED" as const;
  constructor(context?: Record<string, unknown>) {
    super("Account is temporarily locked", context);
  }
}

export class AccountDeactivatedError extends AppAuthError {
  readonly code = "AUTH_ACCOUNT_DEACTIVATED" as const;
  constructor(context?: Record<string, unknown>) {
    super("Account is deactivated", context);
  }
}

export class UnauthorizedError extends AppAuthError {
  readonly code = "AUTH_UNAUTHORIZED" as const;
  constructor(context?: Record<string, unknown>) {
    super("Authentication required", context);
  }
}

export class ForbiddenError extends AppAuthError {
  readonly code = "AUTH_FORBIDDEN" as const;
  constructor(context?: Record<string, unknown>) {
    super("Forbidden", context);
  }
}

export class InvalidInputError extends AppAuthError {
  readonly code = "AUTH_INVALID_INPUT" as const;
  constructor(context?: Record<string, unknown>) {
    super("Invalid input", context);
  }
}

export class CsrfError extends AppAuthError {
  readonly code = "AUTH_CSRF" as const;
  constructor(context?: Record<string, unknown>) {
    super("CSRF validation failed", context);
  }
}

export class OriginError extends AppAuthError {
  readonly code = "AUTH_ORIGIN" as const;
  constructor(context?: Record<string, unknown>) {
    super("Origin validation failed", context);
  }
}

export class SessionExpiredError extends AppAuthError {
  readonly code = "AUTH_SESSION_EXPIRED" as const;
  constructor(context?: Record<string, unknown>) {
    super("Session expired", context);
  }
}

export class ConflictError extends AppAuthError {
  readonly code = "AUTH_CONFLICT" as const;
  constructor(context?: Record<string, unknown>) {
    super("Resource conflict", context);
  }
}

export class NotFoundError extends AppAuthError {
  readonly code = "AUTH_NOT_FOUND" as const;
  constructor(context?: Record<string, unknown>) {
    super("Resource not found", context);
  }
}

export class RateLimitedError extends AppAuthError {
  readonly code = "AUTH_RATE_LIMITED" as const;
  constructor(context?: Record<string, unknown>) {
    super("Too many requests", context);
  }
}

export function isAppAuthError(value: unknown): value is AppAuthError {
  return value instanceof AppAuthError;
}
