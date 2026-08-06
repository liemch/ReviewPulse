import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEmail } from "./email.js";
import { InvalidInputError } from "./errors.js";
import {
  assertCsrf,
  assertOrigin,
  issueCsrfToken,
} from "./csrf.js";
import { CsrfError, OriginError } from "./errors.js";
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password.js";
import {
  hashSessionToken,
  mintSessionToken,
} from "./session-crypto.js";

describe("normalizeEmail", () => {
  it("trims, NFKC-normalizes, and lowercases", () => {
    assert.equal(normalizeEmail("  Ada.Lovelace@Example.COM "), "ada.lovelace@example.com");
  });

  it("rejects empty or malformed input", () => {
    assert.throws(() => normalizeEmail(""), InvalidInputError);
    assert.throws(() => normalizeEmail("not-an-email"), InvalidInputError);
  });
});

describe("password argon2id", () => {
  it("hashes and verifies without echoing plaintext", async () => {
    const password = "correct-horse-battery";
    const hash = await hashPassword(password);
    assert.equal(hash.includes(password), false);
    assert.equal(await verifyPassword(hash, password), true);
    assert.equal(await verifyPassword(hash, "wrong-password!!"), false);
  });

  it("rejects short or whitespace-padded passwords", () => {
    assert.throws(() => assertPasswordPolicy("short"), InvalidInputError);
    assert.throws(() => assertPasswordPolicy("  padded-password  "), InvalidInputError);
  });
});

describe("session token hashing", () => {
  it("never stores the raw token as the hash", () => {
    const token = mintSessionToken();
    const hash = hashSessionToken(token, "ci-only-session-secret-min-32-chars-xx");
    assert.notEqual(hash, token);
    assert.equal(hash.includes(token), false);
  });
});

describe("csrf and origin", () => {
  it("accepts matching double-submit tokens", () => {
    const token = issueCsrfToken();
    assertCsrf(token, token);
    assert.throws(() => assertCsrf(token, "other"), CsrfError);
  });

  it("accepts an allowed Origin and rejects others", () => {
    assertOrigin(
      { origin: "http://localhost:3000", referer: null },
      ["http://localhost:3000"],
    );
    assert.throws(
      () =>
        assertOrigin(
          { origin: "https://evil.example", referer: null },
          ["http://localhost:3000"],
        ),
      OriginError,
    );
    assert.throws(
      () => assertOrigin({ origin: null, referer: null }, ["http://localhost:3000"]),
      OriginError,
    );
  });
});

describe("public signup absence", () => {
  it("package does not export a signup helper", async () => {
    const api = await import("./index.js");
    assert.equal("signup" in api, false);
    assert.equal("register" in api, false);
    assert.equal("createPublicUser" in api, false);
  });
});
