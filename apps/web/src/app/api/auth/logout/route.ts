import { NextResponse } from "next/server";

import { assertCsrf, assertOrigin, issueCsrfToken } from "@reviewpulse/app-auth";
import { toSafeErrorPayload } from "@reviewpulse/crypto";

import {
  allowedOrigins,
  clearSessionCookie,
  parseForm,
  readCookie,
  requireUser,
  setCsrfCookie,
} from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const services = getServices();
  const url = new URL(request.url);
  const wantsJson =
    (request.headers.get("accept") ?? "").includes("application/json") ||
    (request.headers.get("content-type") ?? "").includes("application/json");

  try {
    const form = await parseForm(request);
    assertOrigin(
      {
        origin: request.headers.get("origin"),
        referer: request.headers.get("referer"),
      },
      allowedOrigins(),
    );
    assertCsrf(
      readCookie(
        request.headers.get("cookie") ?? "",
        services.policy.csrfCookieName,
      ),
      form.get("csrf") ?? request.headers.get("x-csrf-token") ?? undefined,
    );

    const { user, sessionId } = await requireUser();
    await services.sessions.revokeSession(sessionId, user.id);
    const response = wantsJson
      ? NextResponse.json({ ok: true })
      : NextResponse.redirect(new URL("/login", url.origin));
    clearSessionCookie(response, services.policy);
    setCsrfCookie(response, services.policy, issueCsrfToken());
    return response;
  } catch (error) {
    if (wantsJson) {
      const payload = toSafeErrorPayload(error);
      return NextResponse.json(
        { error: { code: payload.code, message: payload.message } },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL("/login", url.origin));
  }
}
