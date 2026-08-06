import { NextResponse } from "next/server";

import {
  assertCsrf,
  assertOrigin,
  issueCsrfToken,
} from "@reviewpulse/app-auth";
import { toSafeErrorPayload } from "@reviewpulse/crypto";

import {
  allowedOrigins,
  parseForm,
  readCookie,
  readSessionToken,
  setCsrfCookie,
  setSessionCookie,
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

    const prior = await readSessionToken();
    let priorSessionId: string | null = null;
    if (prior) {
      try {
        const validated = await services.sessions.validateToken(prior);
        priorSessionId = validated.session.id;
      } catch {
        priorSessionId = null;
      }
    }

    const result = await services.auth.login({
      email: form.get("email") ?? "",
      password: form.get("password") ?? "",
      userAgent: request.headers.get("user-agent"),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      priorSessionId,
    });

    const response = wantsJson
      ? NextResponse.json({
          ok: true,
          user: {
            id: result.user.id,
            email: result.user.email,
            role: result.user.role,
          },
        })
      : NextResponse.redirect(new URL("/settings/security", url.origin));

    setSessionCookie(response, services.policy, result.sessionToken);
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
    return NextResponse.redirect(new URL("/login?error=1", url.origin));
  }
}
