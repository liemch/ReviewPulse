import { NextResponse } from "next/server";

import { issueCsrfToken } from "@reviewpulse/app-auth";

import { appOrigin, setCsrfCookie } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/login";
  // Only allow relative redirects.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/login";
  const services = getServices();
  const response = NextResponse.redirect(new URL(safeNext, appOrigin()));
  setCsrfCookie(response, services.policy, issueCsrfToken());
  return response;
}
