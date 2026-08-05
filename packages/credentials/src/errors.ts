/**
 * Typed credential errors with fixed messages.
 *
 * Nothing derived from a PAT, envelope, driver message, or SQL statement is
 * ever interpolated here: these errors are safe to log and to surface to a
 * trusted caller.
 */

export type CredentialErrorCode =
  | "INVALID_PAT"
  | "INVALID_INVALIDATION_REASON"
  | "CONNECTION_NOT_FOUND"
  | "ACTIVE_CREDENTIAL_EXISTS"
  | "NO_ACTIVE_CREDENTIAL"
  | "CONCURRENT_CREDENTIAL_REPLACE"
  | "CREDENTIAL_UNREADABLE"
  | "CREDENTIAL_STORE_FAILED";

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  readonly safeForClient = true as const;

  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

export class InvalidPatError extends CredentialError {
  constructor() {
    super(
      "INVALID_PAT",
      "Personal access token must be a non-empty string with no surrounding or control whitespace",
    );
    this.name = "InvalidPatError";
  }
}

export class InvalidInvalidationReasonError extends CredentialError {
  constructor() {
    super(
      "INVALID_INVALIDATION_REASON",
      "Invalidation reason is not one of the supported values",
    );
    this.name = "InvalidInvalidationReasonError";
  }
}

export class ConnectionNotFoundError extends CredentialError {
  constructor() {
    super("CONNECTION_NOT_FOUND", "GitLab connection does not exist");
    this.name = "ConnectionNotFoundError";
  }
}

export class ActiveCredentialExistsError extends CredentialError {
  constructor() {
    super(
      "ACTIVE_CREDENTIAL_EXISTS",
      "Connection already has an active credential; use replaceCredential",
    );
    this.name = "ActiveCredentialExistsError";
  }
}

export class NoActiveCredentialError extends CredentialError {
  constructor() {
    super("NO_ACTIVE_CREDENTIAL", "Connection has no active credential");
    this.name = "NoActiveCredentialError";
  }
}

export class ConcurrentCredentialReplaceError extends CredentialError {
  constructor() {
    super(
      "CONCURRENT_CREDENTIAL_REPLACE",
      "Another credential change for this connection won the race; retry",
    );
    this.name = "ConcurrentCredentialReplaceError";
  }
}

export class CredentialUnreadableError extends CredentialError {
  constructor() {
    super(
      "CREDENTIAL_UNREADABLE",
      "Stored credential could not be opened with the configured key",
    );
    this.name = "CredentialUnreadableError";
  }
}

export class CredentialStoreFailedError extends CredentialError {
  constructor() {
    super("CREDENTIAL_STORE_FAILED", "Credential could not be persisted");
    this.name = "CredentialStoreFailedError";
  }
}

export function isCredentialError(value: unknown): value is CredentialError {
  return value instanceof CredentialError;
}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PRISMA_UNIQUE_VIOLATION = "P2002";
const PRISMA_FOREIGN_KEY_VIOLATION = "P2003";

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      codes.push(code);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

export function isUniqueViolation(error: unknown): boolean {
  return errorCodes(error).some(
    (code) => code === PRISMA_UNIQUE_VIOLATION || code === PG_UNIQUE_VIOLATION,
  );
}

export function isForeignKeyViolation(error: unknown): boolean {
  return errorCodes(error).some(
    (code) =>
      code === PRISMA_FOREIGN_KEY_VIOLATION || code === PG_FOREIGN_KEY_VIOLATION,
  );
}
