import { InvalidPatError } from "./errors.js";

/**
 * Any C0 control character plus DEL. Covers tab, newline, and carriage return,
 * and keeps a PAT safe to place in an HTTP header value later.
 */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

/**
 * PAT input policy — validate, never normalize.
 *
 * A PAT that needs trimming is a copy-paste accident, not a token: silently
 * fixing it would seal one value while the user believes another was stored.
 * The returned string is byte-for-byte the caller's input.
 */
export function assertValidPat(pat: unknown): string {
  if (typeof pat !== "string") {
    throw new InvalidPatError();
  }
  if (pat.length === 0) {
    throw new InvalidPatError();
  }
  const trimmed = pat.trim();
  if (trimmed.length === 0 || trimmed !== pat) {
    throw new InvalidPatError();
  }
  if (CONTROL_CHARACTER.test(pat)) {
    throw new InvalidPatError();
  }
  return pat;
}

/**
 * Display-only hint taken from the already validated plaintext — no separate
 * trim, so the hint always describes exactly what was sealed.
 * Never logged by default.
 */
export function patHintLast4(validatedPat: string): string {
  return validatedPat.slice(-4);
}
