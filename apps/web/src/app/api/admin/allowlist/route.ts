import { NextResponse } from "next/server";

import { assertCsrf, assertOrigin } from "@reviewpulse/app-auth";

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

const REDIRECT = "/settings/admin/allowlist";

export async function GET(): Promise<NextResponse> {
  try {
    await requireAdmin();
    const services = getServices();
    const instances = await services.allowlist.listInstances();
    const projects = await services.allowlist.listProjects();
    return NextResponse.json({ instances, projects });
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

    const { user } = await requireAdmin();
    const action = form.get("action") ?? "";
    const requireHttps = process.env.NODE_ENV === "production";

    if (action === "add_instance") {
      const row = await services.allowlist.addInstance({
        baseUrl: form.get("baseUrl") ?? "",
        label: form.get("label"),
        internal: form.get("internal") === "true",
        requireHttps,
      });
      await services.audit.write("allowlist_instance_added", user.id, {
        instanceId: row.id,
      });
      if (json) {
        return NextResponse.json({ ok: true, instance: row });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "remove_instance") {
      const instanceId = form.get("instanceId") ?? "";
      await services.allowlist.removeInstance(instanceId);
      await services.audit.write("allowlist_instance_removed", user.id, {
        instanceId,
      });
      if (json) {
        return NextResponse.json({ ok: true });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "add_project") {
      const row = await services.allowlist.addProject({
        gitlabInstanceId: form.get("gitlabInstanceId") ?? "",
        gitlabProjectId: form.get("gitlabProjectId") ?? "",
        pathWithNamespace: form.get("pathWithNamespace"),
      });
      await services.audit.write("allowlist_project_added", user.id, {
        projectAllowlistId: row.id,
      });
      if (json) {
        return NextResponse.json({ ok: true, project: row });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "remove_project") {
      const id = form.get("id") ?? "";
      await services.allowlist.removeProject(id);
      await services.audit.write("allowlist_project_removed", user.id, {
        projectAllowlistId: id,
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
