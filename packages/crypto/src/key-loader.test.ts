import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createEnvKeyLoader,
  createStaticKeyLoader,
  decodeKeyMaterial,
  KEY_BYTES,
  parseKeyVersionLabel,
} from "./key-loader.js";

const VALID_KEY = randomBytes(KEY_BYTES).toString("base64");

describe("decodeKeyMaterial", () => {
  it("accepts canonical standard base64 of exactly 32 bytes", () => {
    for (let i = 0; i < 50; i += 1) {
      const key = randomBytes(KEY_BYTES).toString("base64");
      assert.equal(key.length, 44);
      assert.equal(decodeKeyMaterial(key).length, KEY_BYTES);
    }
  });

  it("rejects wrong decoded lengths, including 31 and 33 bytes", () => {
    for (const bytes of [1, 16, 24, 31, 33, 48, 64]) {
      assert.throws(
        () => decodeKeyMaterial(randomBytes(bytes).toString("base64")),
        { code: "INVALID_KEY_MATERIAL" },
        `expected ${bytes} bytes to be rejected`,
      );
    }
  });

  it("rejects characters outside the standard base64 alphabet", () => {
    const valid = randomBytes(KEY_BYTES).toString("base64");
    for (const candidate of [
      "not a key",
      "supersecretpassphrase-with-32-chars",
      "****************************************",
      `${valid.slice(0, 20)}!${valid.slice(21)}`,
      `${valid.slice(0, 20)}#${valid.slice(21)}`,
      `${valid.slice(0, 20)}-${valid.slice(21)}`,
      `${valid.slice(0, 20)}_${valid.slice(21)}`,
    ]) {
      assert.throws(
        () => decodeKeyMaterial(candidate),
        { code: "INVALID_KEY_MATERIAL" },
        `expected ${candidate.slice(0, 12)}… to be rejected`,
      );
    }
  });

  it("rejects malformed padding", () => {
    const valid = randomBytes(KEY_BYTES).toString("base64");
    for (const candidate of [
      valid.slice(0, -1), // 32 bytes' worth of characters, padding removed
      `${valid}=`, // over-padded
      `${valid}==`,
      `${valid.slice(0, -1)}===`,
      `=${valid.slice(1)}`, // padding in the wrong position
      `${valid.slice(0, 20)}=${valid.slice(21)}`,
      "A===",
      "====",
    ]) {
      assert.throws(
        () => decodeKeyMaterial(candidate),
        { code: "INVALID_KEY_MATERIAL" },
        `expected padding form ${candidate.slice(-6)} to be rejected`,
      );
    }
  });

  it("rejects any whitespace, including a trailing newline from a shell export", () => {
    const valid = randomBytes(KEY_BYTES).toString("base64");
    for (const candidate of [
      "",
      "   ",
      "\n",
      ` ${valid}`,
      `${valid} `,
      `${valid}\n`,
      `${valid}\r\n`,
      `${valid}\t`,
      `${valid.slice(0, 20)} ${valid.slice(21)}`,
      `${valid.slice(0, 20)}\n${valid.slice(21)}`,
    ]) {
      assert.throws(
        () => decodeKeyMaterial(candidate),
        { code: "INVALID_KEY_MATERIAL" },
        "whitespace must never be trimmed away",
      );
    }
  });

  it("rejects non-canonical base64 that a permissive decoder would accept", () => {
    // Buffer.from would happily decode these to 32 bytes by ignoring or
    // truncating input; the round-trip check is what stops them.
    const permissive = ["AAAA".repeat(11), `${VALID_KEY}extra`];
    for (const candidate of permissive) {
      assert.throws(() => decodeKeyMaterial(candidate), {
        code: "INVALID_KEY_MATERIAL",
      });
    }
  });

  it("rejects base64url input because the locked format is standard base64", () => {
    for (let i = 0; i < 50; i += 1) {
      const urlish = randomBytes(KEY_BYTES).toString("base64url");
      if (urlish.includes("-") || urlish.includes("_")) {
        assert.throws(() => decodeKeyMaterial(urlish), {
          code: "INVALID_KEY_MATERIAL",
        });
      }
    }
  });

  it("rejects the .env.example placeholder as a usable key", () => {
    const envExample = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../.env.example"),
      "utf8",
    );
    const line = envExample
      .split("\n")
      .find((entry) => entry.startsWith("TOKEN_ENCRYPTION_KEY="));

    assert.ok(line, "TOKEN_ENCRYPTION_KEY must be documented in .env.example");
    const placeholder = line.slice("TOKEN_ENCRYPTION_KEY=".length);
    assert.throws(() => decodeKeyMaterial(placeholder), {
      code: "INVALID_KEY_MATERIAL",
    });
  });

  it("does not put key material into the error", () => {
    const nearMiss = `${VALID_KEY}\n`;
    try {
      decodeKeyMaterial(nearMiss);
      assert.fail("expected rejection");
    } catch (error) {
      const serialized = `${String(error)}${JSON.stringify(error)}${
        (error as Error).stack ?? ""
      }`;
      assert.ok(!serialized.includes(VALID_KEY));
      assert.ok(!serialized.includes(VALID_KEY.slice(0, 8)));
    }
  });
});

describe("parseKeyVersionLabel", () => {
  it("maps v1 to 1", () => {
    assert.equal(parseKeyVersionLabel("v1"), 1);
    assert.equal(parseKeyVersionLabel("V2"), 2);
    assert.equal(parseKeyVersionLabel(" 3 "), 3);
  });

  it("rejects non-positive and free-form labels", () => {
    for (const label of ["", "v0", "0", "-1", "latest", "v1.1", "vone"]) {
      assert.throws(() => parseKeyVersionLabel(label), {
        code: "INVALID_KEY_VERSION",
      });
    }
  });
});

describe("createStaticKeyLoader", () => {
  it("returns the current key and rejects other versions", () => {
    const loader = createStaticKeyLoader(VALID_KEY, "v1");

    assert.equal(loader.currentKey().version, 1);
    assert.equal(loader.keyForVersion(1).version, 1);
    assert.throws(() => loader.keyForVersion(2), {
      code: "KEY_VERSION_MISMATCH",
    });
  });
});

describe("createEnvKeyLoader", () => {
  it("reads an injected environment", () => {
    const loader = createEnvKeyLoader({
      TOKEN_ENCRYPTION_KEY: VALID_KEY,
      TOKEN_ENCRYPTION_KEY_VERSION: "v1",
    } as NodeJS.ProcessEnv);

    assert.equal(loader.currentKey().key.length, KEY_BYTES);
  });

  it("fails closed when the key or version is missing", () => {
    assert.throws(
      () =>
        createEnvKeyLoader({
          TOKEN_ENCRYPTION_KEY_VERSION: "v1",
        } as NodeJS.ProcessEnv),
      { code: "INVALID_KEY_MATERIAL" },
    );
    assert.throws(
      () =>
        createEnvKeyLoader({
          TOKEN_ENCRYPTION_KEY: VALID_KEY,
        } as NodeJS.ProcessEnv),
      { code: "INVALID_KEY_VERSION" },
    );
  });
});
