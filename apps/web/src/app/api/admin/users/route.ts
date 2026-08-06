import { NextResponse } from "next/server";

import { assertCsrf, assertOrigin } from "@reviewpulse/app-auth";
import type { UserRole } from "@reviewpulse/db";

import {
  allowedOrigins,
  formRedirect,
  jsonError,
  parseForm,
  readCookie,
  requireAdmin,
  wantsJson,
} from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const REDIRECT = "/settings/admin/users";

export async function GET(): Promise<NextResponse> {
  try {
    const { user } = await requireAdmin();
    const users = await getServices().users.listUsers(user);
    return NextResponse.json({ users });
  } catch (error) {
    return jsonError(error, 403);
  }
}

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

    const { user: actor } = await requireAdmin();
    const action = form.get("action") ?? "create";

    if (action === "create" || action === "invite") {
      const created = await services.users.createUser({
        actor,
        email: form.get("email") ?? "",
        password: form.get("password") ?? "",
        role: (form.get("role") ?? "developer") as UserRole,
        invited: action === "invite",
      });
      if (json) {
        return NextResponse.json({ ok: true, user: created });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "deactivate") {
      await services.users.deactivateUser({
        actor,
        userId: form.get("userId") ?? "",
      });
      if (json) {
        return NextResponse.json({ ok: true });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "reset_password") {
      await services.users.resetPassword({
        actor,
        userId: form.get("userId") ?? "",
        newPassword: form.get("password") ?? "",
      });
      if (json) {
        return NextResponse.json({ ok: true });
      }
      return formRedirect(request, REDIRECT);
    }

    if (json) {
      return NextResponse.json({ error: { message: "Unknown action" } }, { status: 400 });
    }
    return formRedirect(request, REDIRECT, { error: "unknown_action" });
  } catch (error) {
    if (json) {
      return jsonError(error);
    }
    return formRedirect(request, REDIRECT, { error: "1" });
  }
}
