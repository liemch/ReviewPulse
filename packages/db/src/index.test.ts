import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("@reviewpulse/db", () => {
  it("exports checkDatabaseConnectivity as a function", async () => {
    const mod = await import("./index.js");
    assert.equal(typeof mod.checkDatabaseConnectivity, "function");
  });
});
