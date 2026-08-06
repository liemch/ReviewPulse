/** Session token hashing and TTL policy. */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { InvalidInputError } from "./errors.js";

export const SESSION_ABS_TTL_SECONDS_DEFAULT = 43_200; // 12h
export const SESSION_IDLE_TTL_SECONDS_DEFAULT = 7_200; // 2h

export type SessionPolicy = {
  readonly absTtlSeconds: number;
  readonly idleTtlSeconds: number;
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly cookieName: string;
  readonly csrfCookieName: string;
};

export function loadSessionPolicy(
  env: Record<string, string | undefined> = process.env,
): SessionPolicy {
  const sessionSecret = env["SESSION_SECRET"] ?? "";
  if (sessionSecret.length < 32) {
    throw new InvalidInputError({ reason: "session_secret_missing" });
  }
  const absTtlSeconds = parsePositiveInt(
    env["SESSION_ABS_TTL_SECONDS"],
    SESSION_ABS_TTL_SECONDS_DEFAULT,
  );
  const idleTtlSeconds = parsePositiveInt(
    env["SESSION_IDLE_TTL_SECONDS"],
    SESSION_IDLE_TTL_SECONDS_DEFAULT,
  );
  const secureCookies = resolveSecureCookies(env);

  return {
    absTtlSeconds,
    idleTtlSeconds,
    sessionSecret,
    secureCookies,
    cookieName: secureCookies ? "__Host-rp_session" : "rp_session",
    csrfCookieName: secureCookies ? "__Host-rp_csrf" : "rp_csrf",
  };
}

/**
 * S8: `__Host-` only for HTTPS deploy. Plain `http://` APP_ORIGIN (local) must
 * use non-Host cookies even if COOKIE_SECURE=true was left in `.env`.
 */
function resolveSecureCookies(
  env: Record<string, string | undefined>,
): boolean {
  // A plain `http://` origin can never carry Secure / `__Host-` cookies, so the
  // guard also wins over FORCE_SECURE_COOKIES / COOKIE_SECURE left on in `.env`.
  const origin = (env["APP_ORIGIN"] ?? "").trim().toLowerCase();
  if (origin.startsWith("http://")) {
    return false;
  }
  if (env["FORCE_SECURE_COOKIES"] === "true") {
    return true;
  }
  if (env["COOKIE_SECURE"] === "false") {
    return false;
  }
  return (
    env["COOKIE_SECURE"] === "true" || env["NODE_ENV"] === "production"
  );
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

/** 32 random bytes, base64url — the only form that ever leaves the server. */
export function mintSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(
  token: string,
  sessionSecret: string,
): string {
  return createHmac("sha256", sessionSecret).update(token).digest("base64url");
}

export function mintCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function csrfTokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function hashFingerprint(
  value: string | null | undefined,
  sessionSecret: string,
): string | null {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  return createHmac("sha256", sessionSecret)
    .update("fp:")
    .update(value)
    .digest("base64url");
}
