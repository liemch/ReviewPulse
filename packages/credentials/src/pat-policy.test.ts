import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redact, toSafeErrorPayload } from "@reviewpulse/crypto";

import { assertValidPat, patHintLast4 } from "./pat-policy.js";

const VALID_PAT = "glpat-EXAMPLE-not-a-real-token-9876";

describe("assertValidPat", () => {
  it("returns a valid PAT byte-for-byte", () => {
    const result = assertValidPat(VALID_PAT);

    assert.equal(result, VALID_PAT);
    assert.equal(result.length, VALID_PAT.length);
  });

  it("accepts tokens whose characters merely look unusual", () => {
    for (const pat of ["a", "glpat--__..xyz", "1234"]) {
      assert.equal(assertValidPat(pat), pat);
    }
  });

  it("rejects an empty PAT", () => {
    assert.throws(() => assertValidPat(""), { code: "INVALID_PAT" });
  });

  it("rejects a whitespace-only PAT", () => {
    for (const pat of [" ", "   ", "\t", "\n", "\r\n", " \t\n "]) {
      assert.throws(() => assertValidPat(pat), { code: "INVALID_PAT" });
    }
  });

  it("rejects a leading space instead of trimming it", () => {
    assert.throws(() => assertValidPat(` ${VALID_PAT}`), { code: "INVALID_PAT" });
  });

  it("rejects a trailing space instead of trimming it", () => {
    assert.throws(() => assertValidPat(`${VALID_PAT} `), { code: "INVALID_PAT" });
  });

  it("rejects a trailing newline instead of trimming it", () => {
    assert.throws(() => assertValidPat(`${VALID_PAT}\n`), { code: "INVALID_PAT" });
    assert.throws(() => assertValidPat(`${VALID_PAT}\r\n`), { code: "INVALID_PAT" });
  });

  it("rejects tabs and carriage returns anywhere in the PAT", () => {
    for (const pat of [
      `\t${VALID_PAT}`,
      `${VALID_PAT}\t`,
      `glpat-abc\tdef`,
      `glpat-abc\rdef`,
      `glpat-abc\ndef`,
      `glpat-abc\u0000def`,
      `glpat-abc\u007Fdef`,
    ]) {
      assert.throws(() => assertValidPat(pat), { code: "INVALID_PAT" });
    }
  });

  it("rejects non-string input", () => {
    for (const pat of [undefined, null, 42, {}, []]) {
      assert.throws(() => assertValidPat(pat), { code: "INVALID_PAT" });
    }
  });

  it("never echoes the input or the rejected part in the error", () => {
    const rejected = `${VALID_PAT}\n`;

    try {
      assertValidPat(rejected);
      assert.fail("expected INVALID_PAT");
    } catch (error) {
      const serialized = `${String(error)}${JSON.stringify(error)}${
        JSON.stringify(redact(error))
      }${(error as Error).stack ?? ""}`;

      assert.ok(!serialized.includes(VALID_PAT));
      assert.ok(!serialized.includes("9876"));
      assert.deepEqual(toSafeErrorPayload(error), {
        code: "INVALID_PAT",
        message: (error as Error).message,
      });
    }
  });
});

describe("patHintLast4", () => {
  it("takes the last four characters of the validated plaintext", () => {
    assert.equal(patHintLast4(assertValidPat(VALID_PAT)), "9876");
    assert.equal(patHintLast4(assertValidPat("abc")), "abc");
    assert.equal(patHintLast4(assertValidPat("1234")), "1234");
  });

  it("does not trim on its own — the hint describes exactly what was sealed", () => {
    assert.equal(patHintLast4(" 1234 "), "234 ");
  });
});
