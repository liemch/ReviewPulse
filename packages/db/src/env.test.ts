import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  summarizeEnvIssues,
  summarizeEnvWarnings,
  validateRuntimeEnv,
  validateWp0Env,
} from "./env.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("validateWp0Env", () => {
  it("allows empty secrets in WP0", () => {
    const result = validateWp0Env({
      DATABASE_URL: "postgresql://u:p@localhost:5432/reviewpulse",
      TOKEN_ENCRYPTION_KEY: "",
      SESSION_SECRET: "",
    });
    assert.equal(result.ok, true);
  });

  it("rejects TOKEN_ENCRYPTION_KEY that is not 32 bytes", () => {
    const result = validateWp0Env({
      TOKEN_ENCRYPTION_KEY: Buffer.from("too-short").toString("base64"),
    });
    assert.equal(result.ok, false);
    assert.ok(
      summarizeEnvIssues(result).some((m) => m.includes("TOKEN_ENCRYPTION_KEY")),
    );
  });

  it("accepts 32-byte TOKEN_ENCRYPTION_KEY", () => {
    const result = validateWp0Env({
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    });
    assert.equal(result.ok, true);
  });

  it("rejects short SESSION_SECRET when set", () => {
    const result = validateWp0Env({ SESSION_SECRET: "short" });
    assert.equal(result.ok, false);
    assert.ok(
      summarizeEnvIssues(result).some((m) => m.includes("SESSION_SECRET")),
    );
  });

  it("never embeds secret values in issue messages", () => {
    const secret = "super-secret-value-abcdefghijklmnopqrstuvwxyz";
    const result = validateWp0Env({ SESSION_SECRET: "short" });
    const joined = summarizeEnvIssues(result).join(" ");
    assert.equal(joined.includes(secret), false);
    assert.equal(joined.includes("short"), false);
  });
});

describe("validateRuntimeEnv", () => {
  const good = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/reviewpulse",
    SESSION_SECRET: "x".repeat(32),
    TOKEN_ENCRYPTION_KEY: VALID_KEY,
    TOKEN_ENCRYPTION_KEY_VERSION: "v1",
    APP_ORIGIN: "http://localhost:3000",
  };

  it("passes when all required keys are valid", () => {
    const result = validateRuntimeEnv(good);
    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 0);
  });

  it("reports every missing key in one result", () => {
    const result = validateRuntimeEnv({});
    assert.equal(result.ok, false);
    const keys = result.issues.map((i) => i.key).sort();
    assert.deepEqual(keys, [
      "APP_ORIGIN",
      "DATABASE_URL",
      "SESSION_SECRET",
      "TOKEN_ENCRYPTION_KEY",
      "TOKEN_ENCRYPTION_KEY_VERSION",
    ]);
  });

  it("warns when GITLAB_URL_ALLOWLIST is empty without failing", () => {
    const result = validateRuntimeEnv(good);
    assert.equal(result.ok, true);
    assert.ok(
      summarizeEnvWarnings(result).some((m) =>
        m.includes("GITLAB_URL_ALLOWLIST"),
      ),
    );
  });

  it("rejects a non-canonical encryption key", () => {
    const result = validateRuntimeEnv({
      ...good,
      TOKEN_ENCRYPTION_KEY: `${VALID_KEY}\n`,
    });
    assert.equal(result.ok, false);
    assert.ok(
      summarizeEnvIssues(result).some((m) => m.includes("TOKEN_ENCRYPTION_KEY")),
    );
  });

  it("rejects a bad key version label", () => {
    const result = validateRuntimeEnv({
      ...good,
      TOKEN_ENCRYPTION_KEY_VERSION: "prod",
    });
    assert.equal(result.ok, false);
    assert.ok(
      summarizeEnvIssues(result).some((m) =>
        m.includes("TOKEN_ENCRYPTION_KEY_VERSION"),
      ),
    );
  });

  it("rejects a non-positive membership cache TTL when set", () => {
    const result = validateRuntimeEnv({
      ...good,
      MEMBERSHIP_CACHE_TTL_SECONDS: "0",
    });
    assert.equal(result.ok, false);
    assert.ok(
      summarizeEnvIssues(result).some((m) =>
        m.includes("MEMBERSHIP_CACHE_TTL_SECONDS"),
      ),
    );
  });

  it("never embeds secret values in runtime issue messages", () => {
    const secret = "leak-me-please-abcdefghijklmnopqrstuvwxyz012345";
    const result = validateRuntimeEnv({
      ...good,
      SESSION_SECRET: "too-short",
      TOKEN_ENCRYPTION_KEY: secret,
    });
    const joined = [
      ...summarizeEnvIssues(result),
      ...summarizeEnvWarnings(result),
    ].join(" ");
    assert.equal(joined.includes(secret), false);
    assert.equal(joined.includes("too-short"), false);
  });
});
