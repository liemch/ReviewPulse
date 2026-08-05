import { NextResponse } from "next/server";

export type HealthPayload = {
  status: "ok";
  service: "reviewpulse-web";
};

/** Liveness payload — process up only; no config/secrets. */
export function buildHealthPayload(): HealthPayload {
  return {
    status: "ok",
    service: "reviewpulse-web",
  };
}

export function healthResponse(): NextResponse {
  return NextResponse.json(buildHealthPayload(), { status: 200 });
}
