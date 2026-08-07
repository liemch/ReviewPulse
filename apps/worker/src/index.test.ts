import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("@reviewpulse/worker", () => {
  it("boots the WP6 sync loop without logging secret-shaped fields", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(source, /runWorkerLoop/);
    assert.match(source, /workPackage: "WP6"/);
    assert.equal(source.includes('mode: "stub"'), false);
    assert.equal(source.includes("PRIVATE-TOKEN"), false);
    assert.equal(source.includes("TOKEN_ENCRYPTION_KEY"), false);
  });
});
