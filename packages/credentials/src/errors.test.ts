import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, REDACTED, toSafeErrorPayload } from "@reviewpulse/crypto";

import {
  ConcurrentCredentialReplaceError,
  CredentialError,
  isCredentialError,
  isForeignKeyViolation,
  isUniqueViolation,
  NoActiveCredentialError,
} from "./errors.js";

const PAT = "glpat-EXAMPLE-not-a-real-token-9876";

describe("credential errors", () => {
  it("are typed, safe to serialize, and free of secrets", () => {
    const error = new ConcurrentCredentialReplaceError();

    assert.ok(isCredentialError(error));
    assert.ok(error instanceof CredentialError);
    assert.equal(error.code, "CONCURRENT_CREDENTIAL_REPLACE");
    assert.deepEqual(toSafeErrorPayload(error), {
      code: "CONCURRENT_CREDENTIAL_REPLACE",
      message: error.message,
    });
    assert.ok(!JSON.stringify(error).includes(PAT));
  });

  it("redact attached context before logging", () => {
    const error = Object.assign(new NoActiveCredentialError(), {
      context: { connectionId: "conn_1", pat: PAT, ciphertext: "AAAA" },
    });

    const logged = redact(error) as Record<string, Record<string, unknown>>;

    assert.equal(logged.code, "NO_ACTIVE_CREDENTIAL");
    assert.equal(logged.context?.connectionId, "conn_1");
    assert.equal(logged.context?.pat, REDACTED);
    assert.equal(logged.context?.ciphertext, REDACTED);
    assert.ok(!JSON.stringify(logged).includes(PAT));
  });
});

describe("driver error classification", () => {
  it("detects unique violations from Prisma and from the pg driver", () => {
    assert.ok(isUniqueViolation({ code: "P2002" }));
    assert.ok(isUniqueViolation({ code: "23505" }));
    assert.ok(isUniqueViolation({ code: "UNKNOWN", cause: { code: "23505" } }));
    assert.ok(!isUniqueViolation({ code: "23503" }));
    assert.ok(!isUniqueViolation(null));
  });

  it("detects foreign key violations", () => {
    assert.ok(isForeignKeyViolation({ code: "P2003" }));
    assert.ok(isForeignKeyViolation({ code: "23503" }));
    assert.ok(!isForeignKeyViolation({ code: "23505" }));
  });
});
