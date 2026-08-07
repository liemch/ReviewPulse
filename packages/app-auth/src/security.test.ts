import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SESSION_ABS_TTL_SECONDS_DEFAULT,
  SESSION_IDLE_TTL_SECONDS_DEFAULT,
  loadSessionPolicy,
} from "./session-crypto.js";
import { AuditWriter } from "./audit.js";
import { LockoutService } from "./lockout.js";
import { RateLimitedError } from "./errors.js";

describe("session policy defaults", () => {
  it("locks absolute 12h and idle 2h", () => {
    assert.equal(SESSION_ABS_TTL_SECONDS_DEFAULT, 43_200);
    assert.equal(SESSION_IDLE_TTL_SECONDS_DEFAULT, 7_200);
    const policy = loadSessionPolicy({
      SESSION_SECRET: "ci-only-session-secret-min-32-chars-xx",
      NODE_ENV: "development",
    });
    assert.equal(policy.absTtlSeconds, 43_200);
    assert.equal(policy.idleTtlSeconds, 7_200);
    assert.equal(policy.cookieName, "rp_session");
    assert.equal(policy.csrfCookieName, "rp_csrf");
  });

  it("uses __Host- cookie names when secure cookies are on", () => {
    const policy = loadSessionPolicy({
      SESSION_SECRET: "ci-only-session-secret-min-32-chars-xx",
      COOKIE_SECURE: "true",
      APP_ORIGIN: "https://reviewpulse.example",
    });
    assert.equal(policy.cookieName, "__Host-rp_session");
    assert.equal(policy.csrfCookieName, "__Host-rp_csrf");
    assert.equal(policy.secureCookies, true);
  });

  it("keeps non-Host cookies for plain http APP_ORIGIN even if COOKIE_SECURE=true", () => {
    const policy = loadSessionPolicy({
      SESSION_SECRET: "ci-only-session-secret-min-32-chars-xx",
      COOKIE_SECURE: "true",
      APP_ORIGIN: "http://localhost:3000",
    });
    assert.equal(policy.secureCookies, false);
    assert.equal(policy.cookieName, "rp_session");
    assert.equal(policy.csrfCookieName, "rp_csrf");
  });

  it("keeps non-Host cookies on http APP_ORIGIN even with FORCE_SECURE_COOKIES", () => {
    const policy = loadSessionPolicy({
      SESSION_SECRET: "ci-only-session-secret-min-32-chars-xx",
      FORCE_SECURE_COOKIES: "true",
      NODE_ENV: "production",
      APP_ORIGIN: "http://localhost:3000",
    });
    assert.equal(policy.secureCookies, false);
    assert.equal(policy.cookieName, "rp_session");
  });

  it("still honours FORCE_SECURE_COOKIES behind an https origin", () => {
    const policy = loadSessionPolicy({
      SESSION_SECRET: "ci-only-session-secret-min-32-chars-xx",
      FORCE_SECURE_COOKIES: "true",
      COOKIE_SECURE: "false",
      APP_ORIGIN: "https://reviewpulse.example",
    });
    assert.equal(policy.secureCookies, true);
    assert.equal(policy.cookieName, "__Host-rp_session");
  });
});
describe("audit writer secret rejection", () => {
  it("rejects meta that contains secret-shaped keys", async () => {
    const writer = new AuditWriter({
      auditEvent: {
        create: async () => {
          throw new Error("should not write");
        },
      },
    } as never);

    await assert.rejects(
      () => writer.write("login_success", "user-1", { password: "x" }),
      /audit meta must not include secrets/,
    );
    await assert.rejects(
      () => writer.write("login_success", "user-1", { pat: "glpat-x" }),
      /audit meta must not include secrets/,
    );
    await assert.rejects(
      () => writer.write("login_success", "user-1", { session: "raw" }),
      /audit meta must not include secrets/,
    );
    await assert.rejects(
      () => writer.write("mr_comment", "user-1", { diff: "@@ -1 +1 @@" }),
      /audit meta must not include secrets/,
    );
  });
});

describe("IP lockout", () => {
  it("rate-limits after 20 failures in a minute", () => {
    LockoutService.clearIpBucketsForTests();
    const lockout = new LockoutService({} as never, "ci-only-session-secret-min-32-chars-xx");
    const ip = "203.0.113.9";
    for (let i = 0; i < 20; i += 1) {
      void lockout.recordFailure(null, ip);
    }
    assert.throws(() => lockout.assertIpAllowed(ip), RateLimitedError);
    LockoutService.clearIpBucketsForTests();
  });
});
