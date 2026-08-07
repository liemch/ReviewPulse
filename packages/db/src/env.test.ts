import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseSyncRuntimeConfig,
  RUNTIME_ENV_DEFAULTS,
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

  it("rejects a non-positive membership cache negative TTL when set", () => {
    const result = validateRuntimeEnv({
      ...good,
      MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS: "-5",
    });
    assert.equal(result.ok, false);
    assert.ok(
      summarizeEnvIssues(result).some((m) =>
        m.includes("MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS"),
      ),
    );
  });

  it("accepts positive WP6 runtime values", () => {
    const result = validateRuntimeEnv({
      ...good,
      COMMIT_LOOKBACK_OVERLAP_SECONDS: "120",
      SYNC_POLL_INTERVAL_SECONDS: "5",
      SYNC_JOB_BUDGET_SECONDS: "30",
      SYNC_STALE_CLAIM_SECONDS: "90",
    });
    assert.equal(result.ok, true);
  });

  it("reports every invalid WP6 runtime value", () => {
    const result = validateRuntimeEnv({
      ...good,
      COMMIT_LOOKBACK_OVERLAP_SECONDS: "0",
      SYNC_POLL_INTERVAL_SECONDS: "-1",
      SYNC_JOB_BUDGET_SECONDS: "1.5",
      SYNC_STALE_CLAIM_SECONDS: "not-a-number",
    });
    assert.deepEqual(
      result.issues.map((issue) => issue.key).sort(),
      [
        "COMMIT_LOOKBACK_OVERLAP_SECONDS",
        "SYNC_JOB_BUDGET_SECONDS",
        "SYNC_POLL_INTERVAL_SECONDS",
        "SYNC_STALE_CLAIM_SECONDS",
      ],
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

describe("parseSyncRuntimeConfig", () => {
  it("uses the documented WP6 defaults", () => {
    assert.deepEqual(parseSyncRuntimeConfig({}), {
      commitLookbackOverlapSeconds:
        RUNTIME_ENV_DEFAULTS.COMMIT_LOOKBACK_OVERLAP_SECONDS,
      syncPollIntervalSeconds:
        RUNTIME_ENV_DEFAULTS.SYNC_POLL_INTERVAL_SECONDS,
      syncJobBudgetSeconds: RUNTIME_ENV_DEFAULTS.SYNC_JOB_BUDGET_SECONDS,
      syncStaleClaimSeconds:
        RUNTIME_ENV_DEFAULTS.SYNC_STALE_CLAIM_SECONDS,
    });
  });

  it("parses explicit WP6 values", () => {
    assert.deepEqual(
      parseSyncRuntimeConfig({
        COMMIT_LOOKBACK_OVERLAP_SECONDS: "901",
        SYNC_POLL_INTERVAL_SECONDS: "61",
        SYNC_JOB_BUDGET_SECONDS: "62",
        SYNC_STALE_CLAIM_SECONDS: "301",
      }),
      {
        commitLookbackOverlapSeconds: 901,
        syncPollIntervalSeconds: 61,
        syncJobBudgetSeconds: 62,
        syncStaleClaimSeconds: 301,
      },
    );
  });

  it("throws without reflecting an invalid value", () => {
    const secretLikeValue = "invalid-secret-like-value";
    assert.throws(
      () =>
        parseSyncRuntimeConfig({
          SYNC_JOB_BUDGET_SECONDS: secretLikeValue,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("SYNC_JOB_BUDGET_SECONDS") &&
        !error.message.includes(secretLikeValue),
    );
  });
});
