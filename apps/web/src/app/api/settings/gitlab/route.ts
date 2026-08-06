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

const REDIRECT = "/settings/gitlab";

export async function GET(): Promise<NextResponse> {
  try {
    const { user } = await requireUser();
    const connections = await getServices().connections.listForUser(user.id);
    return NextResponse.json({ connections });
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
    const action = form.get("action") ?? "save";
    const requireHttps = process.env.NODE_ENV === "production";

    if (action === "save" || action === "replace") {
      const connection = await services.connections.saveConnection({
        userId: user.id,
        baseUrl: form.get("baseUrl") ?? "",
        pat: form.get("pat") ?? "",
        requireHttps,
      });
      await services.audit.write(
        action === "replace"
          ? "gitlab_connection_replaced"
          : "gitlab_connection_created",
        user.id,
        { connectionId: connection.id },
      );
      if (json) {
        return NextResponse.json({ ok: true, connection });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "test") {
      const tested = await services.connections.testPat({
        baseUrl: form.get("baseUrl") ?? "",
        pat: form.get("pat") ?? "",
        requireHttps,
      });
      await services.audit.write("gitlab_connection_tested", user.id, {
        gitlabUsername: tested.gitlabUsername,
      });
      if (json) {
        return NextResponse.json({
          ok: true,
          user: {
            id: tested.gitlabUserId,
            username: tested.gitlabUsername,
            name: tested.name,
          },
        });
      }
      return formRedirect(request, REDIRECT, { tested: "1" });
    }

    if (action === "retest") {
      const connection = await services.connections.retestStored({
        userId: user.id,
        connectionId: form.get("connectionId") ?? "",
      });
      if (json) {
        return NextResponse.json({ ok: true, connection });
      }
      return formRedirect(request, REDIRECT);
    }

    if (action === "delete") {
      const connectionId = form.get("connectionId") ?? "";
      await services.connections.deleteConnection({
        userId: user.id,
        connectionId,
      });
      await services.audit.write("gitlab_connection_deleted", user.id, {
        connectionId,
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
