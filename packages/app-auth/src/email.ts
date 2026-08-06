/** Email normalization for unique identity (SPEC / plan D7). */

import { InvalidInputError } from "./errors.js";

/**
 * Trim, Unicode NFKC, ASCII lower-case. Rejects empty / missing `@`.
 * Does not invent or rewrite the local-part beyond case folding.
 */
export function normalizeEmail(input: string): string {
  if (typeof input !== "string") {
    throw new InvalidInputError({ reason: "email_not_string" });
  }
  const normalized = input.trim().normalize("NFKC").toLowerCase();
  if (normalized.length === 0 || !normalized.includes("@")) {
    throw new InvalidInputError({ reason: "email_invalid" });
  }
  if (normalized.length > 320) {
    throw new InvalidInputError({ reason: "email_too_long" });
  }
  return normalized;
}
