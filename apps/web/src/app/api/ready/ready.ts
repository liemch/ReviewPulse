import { NextResponse } from "next/server";

export type ReadyOkPayload = {
  status: "ready";
  checks: { database: "ok" };
};

export type ReadyFailPayload = {
  status: "not_ready";
  checks: { database: "fail" };
};

export type ReadyPayload = ReadyOkPayload | ReadyFailPayload;

/** Build readiness JSON without embedding connection details or secrets. */
export function buildReadyPayload(databaseOk: boolean): ReadyPayload {
  if (!databaseOk) {
    return {
      status: "not_ready",
      checks: { database: "fail" },
    };
  }
  return {
    status: "ready",
    checks: { database: "ok" },
  };
}

export function readyResponse(databaseOk: boolean): NextResponse {
  const payload = buildReadyPayload(databaseOk);
  const status = databaseOk ? 200 : 503;
  return NextResponse.json(payload, { status });
}

export function assertReadyPayloadIsSafe(payload: ReadyPayload): void {
  const raw = JSON.stringify(payload);
  const forbidden = [
    "DATABASE_URL",
    "TOKEN_ENCRYPTION_KEY",
    "SESSION_SECRET",
    "password",
    "postgresql://",
    "postgres://",
    "stack",
    "at Object",
  ];
  for (const needle of forbidden) {
    if (raw.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`ready payload leaked sensitive fragment: ${needle}`);
    }
  }
}
