import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS,
  parseMembershipCacheTtlSeconds,
} from "./membership-cache-config.js";

describe("parseMembershipCacheTtlSeconds", () => {
  it("defaults to 300 seconds when unset", () => {
    assert.equal(parseMembershipCacheTtlSeconds(undefined), 300);
    assert.equal(parseMembershipCacheTtlSeconds(""), 300);
    assert.equal(parseMembershipCacheTtlSeconds("   "), 300);
  });

  it("accepts a positive integer override", () => {
    assert.equal(parseMembershipCacheTtlSeconds("600"), 600);
  });

  it("rejects non-integer and non-positive values", () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      assert.throws(
        () => parseMembershipCacheTtlSeconds(bad),
        /positive integer/i,
      );
    }
  });

  it("locks the default constant at 300", () => {
    assert.equal(DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS, 300);
  });
});
