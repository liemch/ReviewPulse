import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHealthPayload } from "./app/api/health/health.js";
import {
  assertReadyPayloadIsSafe,
  buildReadyPayload,
  readyResponse,
} from "./app/api/ready/ready.js";

describe("health", () => {
  it("returns 200-shaped payload without config or secrets", () => {
    const payload = buildHealthPayload();
    assert.equal(payload.status, "ok");
    assert.equal(payload.service, "reviewpulse-web");
    const raw = JSON.stringify(payload);
    assert.equal(raw.includes("DATABASE_URL"), false);
    assert.equal(raw.includes("TOKEN_ENCRYPTION_KEY"), false);
    assert.equal(raw.includes("SESSION_SECRET"), false);
    assert.equal(Object.keys(payload).sort().join(","), "service,status");
  });
});

describe("readiness", () => {
  it("returns not_ready when database fails", () => {
    const payload = buildReadyPayload(false);
    assert.equal(payload.status, "not_ready");
    assert.equal(payload.checks.database, "fail");
    assertReadyPayloadIsSafe(payload);
  });

  it("returns ready when database ok", () => {
    const payload = buildReadyPayload(true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.checks.database, "ok");
    assertReadyPayloadIsSafe(payload);
  });

  it("maps database failure to HTTP 503", async () => {
    const res = readyResponse(false);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "not_ready");
  });

  it("maps database ok to HTTP 200", async () => {
    const res = readyResponse(true);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ready");
  });
});
