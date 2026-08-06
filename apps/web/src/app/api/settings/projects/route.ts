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

const REDIRECT = "/settings/projects";

export async function GET(): Promise<NextResponse> {
  try {
    const { user } = await requireUser();
    const projects = await getServices().projects.listForUser(user.id);
    return NextResponse.json({ projects });
  } catch (error) {
    return jsonError(error, 401);
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

    const { user } = await requireUser();
    const action = form.get("action") ?? "enable";
    const gitlabInstanceId = form.get("gitlabInstanceId") ?? "";
    const gitlabProjectId = form.get("gitlabProjectId") ?? "";

    if (action === "enable") {
      await services.projects.enable({
        userId: user.id,
        gitlabInstanceId,
        gitlabProjectId,
      });
      await services.audit.write("project_enabled", user.id, {
        gitlabInstanceId,
        gitlabProjectId,
      });
      if (json) {
        return NextResponse.json({ ok: true });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "disable") {
      await services.projects.disable({
        userId: user.id,
        gitlabInstanceId,
        gitlabProjectId,
      });
      await services.audit.write("project_disabled", user.id, {
        gitlabInstanceId,
        gitlabProjectId,
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
