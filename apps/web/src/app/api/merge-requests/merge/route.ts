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
    const reviewedHeadSha = form.get("reviewedHeadSha") ?? "";
    const confirmed = form.get("confirmed") === "1";
    const redirectTo = detailPath(gitlabInstanceId, gitlabProjectId, iid);

    if (!confirmed) {
      return formRedirect(request, redirectTo, { flash: "not_confirmed" });
    }

    const result = await services.mrMutations.merge(
      user.id,
      {
        gitlabInstanceId,
        gitlabProjectId,
        iid: Number.parseInt(iid, 10),
      },
      {
        reviewedHeadSha,
        confirmed: true,
      },
    );

    if (result.ok) {
      return formRedirect(request, redirectTo, { flash: "merge_ok" });
    }
    return formRedirect(request, redirectTo, { flash: result.error });
  } catch {
    return formRedirect(request, "/merge-requests", { error: "1" });
  }
}
