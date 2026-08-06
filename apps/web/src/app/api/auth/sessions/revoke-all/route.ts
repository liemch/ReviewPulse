import { NextResponse } from "next/server";

import { assertCsrf, assertOrigin, issueCsrfToken } from "@reviewpulse/app-auth";

import {
  allowedOrigins,
  clearSessionCookie,
  formRedirect,
  jsonError,
  parseForm,
  readCookie,
  requireUser,
  setCsrfCookie,
  wantsJson,
} from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const services = getServices();
  const json = wantsJson(request);
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
      readCookie(request.headers.get("cookie") ?? "", services.policy.csrfCookieName),
      form.get("csrf") ?? request.headers.get("x-csrf-token") ?? undefined,
    );
    const { user } = await requireUser();
    const count = await services.sessions.revokeAllForUser(user.id, user.id);
    const response = json
      ? NextResponse.json({ ok: true, revoked: count })
      : formRedirect(request, "/login");
    clearSessionCookie(response, services.policy);
    setCsrfCookie(response, services.policy, issueCsrfToken());
    return response;
  } catch (error) {
    if (json) {
      return jsonError(error);
    }
    return formRedirect(request, "/settings/security", { error: "1" });
  }
}
