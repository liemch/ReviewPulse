/** Origin / CSRF helpers for state-changing requests. */

import { CsrfError, OriginError } from "./errors.js";
import { csrfTokensEqual, mintCsrfToken } from "./session-crypto.js";

export function issueCsrfToken(): string {
  return mintCsrfToken();
}

export function assertCsrf(
  cookieToken: string | undefined,
  submittedToken: string | undefined,
): void {
  if (
    typeof cookieToken !== "string" ||
    typeof submittedToken !== "string" ||
    !csrfTokensEqual(cookieToken, submittedToken)
  ) {
    throw new CsrfError();
  }
}

/**
 * Fail closed unless Origin (preferred) or Referer matches an allowed origin.
 * `null` / `same-origin` browsers that omit both are rejected for mutations.
 */
export function assertOrigin(
  headers: {
    origin?: string | null;
    referer?: string | null;
  },
  allowedOrigins: readonly string[],
): void {
  const allowed = new Set(
    allowedOrigins.map((origin) => origin.replace(/\/$/, "")),
  );

  const origin = headers.origin?.trim();
  if (origin && origin.length > 0) {
    if (!allowed.has(origin.replace(/\/$/, ""))) {
      throw new OriginError({ reason: "origin_mismatch" });
    }
    return;
  }

  const referer = headers.referer?.trim();
  if (referer && referer.length > 0) {
    try {
      const refOrigin = new URL(referer).origin;
      if (!allowed.has(refOrigin)) {
        throw new OriginError({ reason: "referer_mismatch" });
      }
      return;
    } catch (error) {
      if (error instanceof OriginError) {
        throw error;
      }
      throw new OriginError({ reason: "referer_unparseable" });
    }
  }

  throw new OriginError({ reason: "missing_origin" });
}
