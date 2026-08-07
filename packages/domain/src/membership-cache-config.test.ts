import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS,
  DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS,
  parseMembershipCacheNegativeTtlSeconds,
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

describe("parseMembershipCacheNegativeTtlSeconds", () => {
  it("defaults to 30 seconds when unset", () => {
    assert.equal(parseMembershipCacheNegativeTtlSeconds(undefined), 30);
    assert.equal(DEFAULT_MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS, 30);
  });

  it("never outlives the positive TTL", () => {
    assert.equal(parseMembershipCacheNegativeTtlSeconds(undefined, 10), 10);
    assert.equal(parseMembershipCacheNegativeTtlSeconds("600", 300), 300);
  });

  it("rejects non-positive integers", () => {
    for (const raw of ["0", "-1", "1.5", "abc"]) {
      assert.throws(
        () => parseMembershipCacheNegativeTtlSeconds(raw),
        /positive integer/i,
      );
    }
  });
});
