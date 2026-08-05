import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeEnvIssues, validateWp0Env } from "./env.js";

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
