import {
  assertCsrf,
  assertOrigin,
} from "@reviewpulse/app-auth";

import {
  allowedOrigins,
  formRedirect,
  parseForm,
  readCookie,
  requireUser,
} from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

function detailPath(
  instanceId: string,
  projectId: string,
  iid: string,
): string {
  return `/merge-requests/${instanceId}/${projectId}/${iid}`;
}

export async function POST(request: Request) {
  const services = getServices();
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

    const { user } = await requireUser();
    const gitlabInstanceId = form.get("gitlabInstanceId") ?? "";
    const gitlabProjectId = form.get("gitlabProjectId") ?? "";
    const iid = form.get("iid") ?? "";
    const body = form.get("body") ?? "";
    const redirectTo = detailPath(gitlabInstanceId, gitlabProjectId, iid);

    const result = await services.mrMutations.comment(
      user.id,
      {
        gitlabInstanceId,
        gitlabProjectId,
        iid: Number.parseInt(iid, 10),
      },
      body,
    );

    if (result.ok) {
      return formRedirect(request, redirectTo, { flash: "comment_ok" });
    }
    return formRedirect(request, redirectTo, {
      flash: result.error === "invalid_input" ? "invalid_input" : result.error,
    });
  } catch {
    return formRedirect(request, "/merge-requests", { error: "1" });
  }
}
