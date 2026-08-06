/** Cookie + request helpers for session/CSRF. */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  assertCsrf,
  assertOrigin,
  type AuthUser,
  type SessionPolicy,
} from "@reviewpulse/app-auth";
import { toSafeErrorPayload } from "@reviewpulse/crypto";

import { getServices } from "./services";

/**
 * Configured application origin. Missing APP_ORIGIN fails closed instead of
 * guessing localhost, so CSRF Origin checks and redirects never widen silently.
 */
export function appOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = (
    env["APP_ORIGIN"] ??
    env["NEXT_PUBLIC_APP_ORIGIN"] ??
    ""
  ).trim();
  if (configured.length === 0) {
    throw new Error("APP_ORIGIN is not configured");
  }
  return configured.replace(/\/$/, "");
}

export function allowedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [appOrigin(env)];
}

export function setSessionCookie(
  response: NextResponse,
  policy: SessionPolicy,
  token: string,
): void {
  response.cookies.set({
    name: policy.cookieName,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: policy.secureCookies,
    path: "/",
    maxAge: policy.absTtlSeconds,
  });
}

export function clearSessionCookie(
  response: NextResponse,
  policy: SessionPolicy,
): void {
  response.cookies.set({
    name: policy.cookieName,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: policy.secureCookies,
    path: "/",
    maxAge: 0,
  });
}

export function setCsrfCookie(
  response: NextResponse,
  policy: SessionPolicy,
  token: string,
): void {
  response.cookies.set({
    name: policy.csrfCookieName,
    value: token,
    httpOnly: false,
    sameSite: "lax",
    secure: policy.secureCookies,
    path: "/",
    maxAge: policy.absTtlSeconds,
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  const { policy } = getServices();
  return jar.get(policy.cookieName)?.value;
}

export async function requireUser(): Promise<{
  user: AuthUser;
  sessionId: string;
}> {
  const { sessions } = getServices();
  const token = await readSessionToken();
  const validated = await sessions.validateToken(token);
  return { user: validated.user, sessionId: validated.session.id };
}

export async function requireAdmin(): Promise<{
  user: AuthUser;
  sessionId: string;
}> {
  const current = await requireUser();
  if (current.user.role !== "admin") {
    const { ForbiddenError } = await import("@reviewpulse/app-auth");
    throw new ForbiddenError({ reason: "admin_only" });
  }
  return current;
}

export function assertMutationGuards(request: Request): void {
  const { policy } = getServices();
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  assertOrigin({ origin, referer }, allowedOrigins());

  const cookieHeader = request.headers.get("cookie") ?? "";
  const csrfCookie = readCookie(cookieHeader, policy.csrfCookieName);
  const csrfHeader =
    request.headers.get("x-csrf-token") ??
    request.headers.get("x-xsrf-token") ??
    undefined;
  assertCsrf(csrfCookie, csrfHeader ?? undefined);
}

export function readCookie(
  cookieHeader: string,
  name: string,
): string | undefined {
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

export async function parseForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    return params;
  }
  const text = await request.text();
  return new URLSearchParams(text);
}

export function jsonError(error: unknown, status = 400): NextResponse {
  const payload = toSafeErrorPayload(error);
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code)
      : payload.code;
  const mappedStatus =
    code === "AUTH_UNAUTHORIZED" || code === "AUTH_SESSION_EXPIRED"
      ? 401
      : code === "AUTH_FORBIDDEN"
        ? 403
        : code === "AUTH_RATE_LIMITED" || code === "AUTH_ACCOUNT_LOCKED"
          ? 429
          : code === "AUTH_CSRF" || code === "AUTH_ORIGIN"
            ? 403
            : status;
  return NextResponse.json(
    { error: { code, message: payload.message } },
    { status: mappedStatus },
  );
}

export function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/json") ||
    accept.includes("application/json")
  );
}

export function formRedirect(
  _request: Request,
  path: string,
  query?: Record<string, string>,
): NextResponse {
  // Target origin comes from APP_ORIGIN, never from the request Host header.
  const target = new URL(path, appOrigin());
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      target.searchParams.set(key, value);
    }
  }
  return NextResponse.redirect(target);
}
