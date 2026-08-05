import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACKAGE_NAME } from "./index.js";

describe("@reviewpulse/crypto", () => {
  it("exports package name", () => {
    assert.equal(PACKAGE_NAME, "@reviewpulse/crypto");
  });
});
