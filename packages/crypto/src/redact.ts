/**
 * Structural redaction for logs, error payloads, and HTTP headers.
 *
 * Key-based, not regex-over-a-log-string: the value is replaced wherever a
 * sensitive key appears, including nested objects, arrays, Map/Set, and
 * Error properties.
 */

export const REDACTED = "[REDACTED]" as const;

/** Matched after normalizing the key (lowercase, `-`/`_`/space removed). */
const EXACT_SENSITIVE_KEYS = new Set([
  "pat",
  "key",
  "iv",
  "tag",
  "sealed",
  "envelope",
]);

/** Matched as a substring of the normalized key, so `sessionId` is covered too. */
const SENSITIVE_KEY_FRAGMENTS = [
  "authorization",
  "privatetoken",
  "accesstoken",
  "encryptedpat",
  "ciphertext",
  "authtag",
  "token",
  "session",
  "password",
  "passwd",
  "secret",
  "nonce",
  "credentials",
  "apikey",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  if (typeof key !== "string") {
    return false;
  }
  const normalized = normalizeKey(key);
  if (EXACT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    return redactErrorObject(value, seen);
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) {
      const name = String(key);
      out[name] = isSensitiveKey(name) ? REDACTED : redactValue(item, seen);
    }
    return out;
  }
  if (value instanceof Set) {
    return [...value].map((item) => redactValue(item, seen));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return REDACTED;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen);
  }
  return out;
}

function redactErrorObject(
  error: Error,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    out.code = code;
  }
  for (const [key, item] of Object.entries(error)) {
    if (key === "name" || key === "message" || key === "code") {
      continue;
    }
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen);
  }
  return out;
}

/** Deep clone with sensitive values replaced. The input is never mutated. */
export function redact<T>(value: T): unknown {
  return redactValue(value, new WeakSet<object>());
}

/** Header bags (plain object or Headers) with sensitive header values removed. */
export function redactHeaders(
  headers: Headers | Record<string, unknown>,
): Record<string, unknown> {
  const entries: [string, unknown][] =
    typeof Headers !== "undefined" && headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers as Record<string, unknown>);

  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(value);
  }
  return out;
}

export type SafeErrorPayload = {
  code: string;
  message: string;
};

/**
 * Opt-in marker. Only errors we construct with fixed, constant messages may
 * have their message forwarded outside the process.
 */
export interface SafeDomainError extends Error {
  readonly code: string;
  readonly safeForClient: true;
}

const UNKNOWN_ERROR: SafeErrorPayload = {
  code: "INTERNAL_ERROR",
  message: "Internal error",
};

export function isSafeDomainError(value: unknown): value is SafeDomainError {
  if (!(value instanceof Error)) {
    return false;
  }
  const candidate = value as Error & {
    safeForClient?: unknown;
    code?: unknown;
  };
  return (
    candidate.safeForClient === true &&
    typeof candidate.code === "string" &&
    candidate.code.length > 0
  );
}

/**
 * Errors crossing a trust boundary: typed code plus its fixed message.
 * Anything unrecognised collapses to a generic payload, so a driver message
 * carrying SQL, ciphertext, or a secret can never leak.
 */
export function toSafeErrorPayload(error: unknown): SafeErrorPayload {
  if (!isSafeDomainError(error)) {
    return UNKNOWN_ERROR;
  }
  return { code: error.code, message: error.message };
}
