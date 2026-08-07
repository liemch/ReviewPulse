import { NextResponse } from "next/server";

import { assertCsrf, assertOrigin } from "@reviewpulse/app-auth";

import {
  allowedOrigins,
  formRedirect,
  jsonError,
  parseForm,
  readCookie,
  requireUser,
  wantsJson,
} from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const REDIRECT = "/settings/security";

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
    const action = form.get("action") ?? "add";

    if (action === "add") {
      const row = await services.emails.addAlias({
        userId: user.id,
        email: form.get("email") ?? "",
      });
      await services.audit.write("email_alias_added", user.id, {
        emailId: row.id,
      });
      if (json) {
        return NextResponse.json({ ok: true });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "remove") {
      await services.emails.removeAlias({
        userId: user.id,
        emailId: form.get("emailId") ?? "",
      });
      await services.audit.write("email_alias_removed", user.id, {
        emailId: form.get("emailId") ?? "",
      });
      if (json) {
        return NextResponse.json({ ok: true });
      }
      return formRedirect(request, REDIRECT);
    }

    if (json) {
      return NextResponse.json(
        { error: { message: "Unknown action" } },
        { status: 400 },
      );
    }
    return formRedirect(request, REDIRECT, { error: "unknown_action" });
  } catch (error) {
    if (json) {
      return jsonError(error);
    }
    return formRedirect(request, REDIRECT, { error: "1" });
  }
}
