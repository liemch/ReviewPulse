import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findMonorepoRoot, loadMonorepoEnv } from "./load-env.js";

describe("loadMonorepoEnv", () => {
  it("finds the monorepo root containing apps/", () => {
    const root = findMonorepoRoot();
    assert.match(root, /ReviewPulse$/);
  });

  it("does not pin NODE_ENV from the root .env file", () => {
    const prior = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    // Force reload so the NODE_ENV guard is exercised again.
    loadMonorepoEnv({ force: true });
    assert.equal(process.env.NODE_ENV, undefined);
    if (prior !== undefined) {
      process.env.NODE_ENV = prior;
    }
  });

  it("keeps the NODE_ENV supplied by Node/Next untouched", () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    loadMonorepoEnv({ force: true });
    assert.equal(process.env.NODE_ENV, "production");
    if (prior === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prior;
    }
  });
});
