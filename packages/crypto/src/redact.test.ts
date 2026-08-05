import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { CryptoError, DecryptionFailedError } from "./errors.js";
import {
  isSensitiveKey,
  redact,
  redactHeaders,
  REDACTED,
  toSafeErrorPayload,
} from "./redact.js";

const PAT = "glpat-EXAMPLE-not-a-real-token-1234";

describe("isSensitiveKey", () => {
  it("matches the locked key list regardless of case or separators", () => {
    for (const key of [
      "authorization",
      "Authorization",
      "private-token",
      "PRIVATE_TOKEN",
      "pat",
      "token",
      "access_token",
      "accessToken",
      "encrypted_pat",
      "ciphertext",
      "nonce",
      "auth_tag",
      "authTag",
      "session",
      "sessionId",
      "password",
      "secret",
      "TOKEN_ENCRYPTION_KEY",
    ]) {
      assert.ok(isSensitiveKey(key), `${key} should be sensitive`);
    }
  });

  it("leaves safe metadata keys alone", () => {
    for (const key of [
      "patHintLast4",
      "pat_hint_last4",
      "keyVersion",
      "key_version",
      "envelopeVersion",
      "connectionId",
      "credentialId",
      "status",
      "path",
    ]) {
      assert.ok(!isSensitiveKey(key), `${key} should not be redacted`);
    }
  });
});

describe("redact", () => {
  it("redacts nested objects and arrays without mutating the input", () => {
    const input = {
      connectionId: "conn_1",
      credential: {
        pat: PAT,
        ciphertext: "AAAA",
        patHintLast4: "1234",
        history: [{ token: PAT }, { note: "ok" }],
      },
    };

    const output = redact(input) as Record<string, Record<string, unknown>>;

    assert.equal(output.connectionId, "conn_1");
    assert.equal(output.credential?.pat, REDACTED);
    assert.equal(output.credential?.ciphertext, REDACTED);
    assert.equal(output.credential?.patHintLast4, "1234");
    assert.deepEqual(output.credential?.history, [
      { token: REDACTED },
      { note: "ok" },
    ]);

    assert.equal(input.credential.pat, PAT, "input must not be mutated");
    assert.ok(!JSON.stringify(output).includes(PAT));
  });

  it("redacts binary envelope material", () => {
    const output = redact({
      nonce: Buffer.from("aaaaaaaaaaaa"),
      ciphertext: new Uint8Array([1, 2, 3]),
      auth_tag: Buffer.alloc(16),
    }) as Record<string, unknown>;

    assert.equal(output.nonce, REDACTED);
    assert.equal(output.ciphertext, REDACTED);
    assert.equal(output.auth_tag, REDACTED);
  });

  it("handles Map, Set, and circular structures", () => {
    const circular: Record<string, unknown> = { password: "hunter2" };
    circular.self = circular;

    const output = redact({
      map: new Map([["access_token", PAT]]),
      set: new Set(["public"]),
      circular,
    }) as Record<string, Record<string, unknown>>;

    assert.equal((output.map as Record<string, unknown>).access_token, REDACTED);
    assert.deepEqual(output.set, ["public"]);
    assert.equal((output.circular as Record<string, unknown>).password, REDACTED);
    assert.ok(!JSON.stringify(output).includes("hunter2"));
  });

  it("redacts attached error properties", () => {
    const error = Object.assign(new Error("credential store failed"), {
      code: "CREDENTIAL_STORE_FAILED",
      pat: PAT,
      context: { ciphertext: "AAAA", connectionId: "conn_1" },
    });

    const output = redact(error) as Record<string, unknown>;

    assert.equal(output.code, "CREDENTIAL_STORE_FAILED");
    assert.equal(output.pat, REDACTED);
    assert.deepEqual(output.context, {
      ciphertext: REDACTED,
      connectionId: "conn_1",
    });
    assert.ok(!JSON.stringify(output).includes(PAT));
  });
});

describe("redactHeaders", () => {
  it("redacts GitLab auth headers from both plain objects and Headers", () => {
    const plain = redactHeaders({
      "Private-Token": PAT,
      Authorization: `Bearer ${PAT}`,
      "content-type": "application/json",
    });

    assert.equal(plain["Private-Token"], REDACTED);
    assert.equal(plain.Authorization, REDACTED);
    assert.equal(plain["content-type"], "application/json");

    const headers = new Headers({
      "private-token": PAT,
      accept: "application/json",
    });
    const fromHeaders = redactHeaders(headers);

    assert.equal(fromHeaders["private-token"], REDACTED);
    assert.equal(fromHeaders.accept, "application/json");
  });
});

describe("toSafeErrorPayload", () => {
  it("forwards typed domain errors only", () => {
    assert.deepEqual(toSafeErrorPayload(new DecryptionFailedError()), {
      code: "DECRYPTION_FAILED",
      message: "Sealed secret failed authenticated decryption",
    });
    assert.ok(new DecryptionFailedError() instanceof CryptoError);
  });

  it("collapses untyped and driver errors to a generic payload", () => {
    const driverError = Object.assign(
      new Error(
        `duplicate key value violates unique constraint; DETAIL: ciphertext=\\x00 pat=${PAT}`,
      ),
      { code: "23505" },
    );

    const payload = toSafeErrorPayload(driverError);

    assert.deepEqual(payload, {
      code: "INTERNAL_ERROR",
      message: "Internal error",
    });
    assert.ok(!JSON.stringify(payload).includes(PAT));
    assert.deepEqual(toSafeErrorPayload("boom"), {
      code: "INTERNAL_ERROR",
      message: "Internal error",
    });
  });
});
