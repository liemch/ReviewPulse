/**
 * Read-only guarantee for M1.
 *
 * This is a structural test, not a behavioral one: it fails if anyone adds a
 * write verb or a mutating method to this package, which is the point where a
 * "read-only integration" quietly stops being read-only.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createGitLabReadClient } from "./client.js";
import { publicResolver, testAuth, TEST_ORIGIN } from "./test-support.js";
import { createSsrfGuard } from "./ssrf.js";
import { createGitLabAllowlist } from "./url.js";
import * as publicApi from "./index.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const NON_PRODUCTION = new Set([
  "test-support.ts",
  "test-tls-material.ts",
  "tls-smoke-child.ts",
]);

function productionSources(): { file: string; content: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts") && !NON_PRODUCTION.has(name))
    .map((name) => ({
      file: name,
      content: readFileSync(join(SRC_DIR, name), "utf8"),
    }));
}

function allPackageSources(): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) {
        if (name.name === "node_modules" || name.name === "dist") {
          continue;
        }
        walk(join(dir, name.name), rel);
        continue;
      }
      if (!name.name.endsWith(".ts") && !name.name.endsWith(".pem") && !name.name.endsWith(".key")) {
        continue;
      }
      out.push({
        file: rel,
        content: readFileSync(join(dir, name.name), "utf8"),
      });
    }
  };
  walk(SRC_DIR);
  return out;
}

describe("read-only guarantee — sources", () => {
  it("contains no HTTP write verbs", () => {
    // `transport.ts` legitimately pins method: "GET".
    const writeVerb = /["'`](POST|PUT|PATCH|DELETE)["'`]/;

    for (const { file, content } of productionSources()) {
      assert.equal(
        writeVerb.test(content),
        false,
        `${file} contains an HTTP write verb`,
      );
    }
  });

  it("pins the only HTTP method to GET", () => {
    const transport = productionSources().find(
      (source) => source.file === "transport.ts",
    );
    assert.ok(transport);

    const methods = [...transport.content.matchAll(/method:\s*"([A-Z]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(methods, ["GET"]);
  });

  it("exposes no request body plumbing", () => {
    for (const { file, content } of productionSources()) {
      assert.equal(
        /\brequestBody\b|\bwrite\(|\.end\(JSON/.test(content),
        false,
        `${file} looks like it can send a request body`,
      );
    }
  });
});

describe("read-only guarantee — public surface", () => {
  it("exports no mutating factory or helper", () => {
    const mutating =
      /^(create|update|delete|remove|post|put|patch|approve|merge|comment|note|close|reopen|award|revoke)[A-Z]/;
    const allowedFactories = new Set([
      "createGitLabReadClient",
      "createGitLabAllowlist",
      "createPatAuthAdapter",
      "createPinnedNodeTransport",
      "createSsrfGuard",
    ]);

    for (const name of Object.keys(publicApi)) {
      if (allowedFactories.has(name)) {
        continue;
      }
      assert.equal(
        mutating.test(name),
        false,
        `${name} looks like a mutation entry point`,
      );
    }
  });

  it("gives the client only read methods", () => {
    const client = createGitLabReadClient({
      instance: { instanceId: "x", baseUrlNormalized: TEST_ORIGIN },
      auth: testAuth(),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist([TEST_ORIGIN]),
        resolve: publicResolver(),
      }),
    });

    const entries = client as unknown as Record<string, unknown>;
    const methods = Object.keys(entries)
      .filter((key) => typeof entries[key] === "function")
      .sort();

    assert.deepEqual(methods, [
      "getCurrentUser",
      "getProject",
      "listAccessibleProjects",
      "listBranches",
      "listCommits",
      "listMergeRequests",
    ]);
  });

  it("does not export request-factory or TLS-bypass hooks", () => {
    const banned = [
      "NodeRequestFactory",
      "PinnedTransportDeps",
      "buildPinnedRequestOptions",
      "pinnedLookup",
      "createEphemeralTlsMaterial",
      "findOpenSsl",
    ];
    for (const name of banned) {
      assert.equal(
        name in publicApi,
        false,
        `${name} must not be part of the package public API`,
      );
    }

    assert.equal(typeof publicApi.createPinnedNodeTransport, "function");
    assert.equal(publicApi.createPinnedNodeTransport.length, 0);

    const indexSource = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
    for (const hook of [
      "NodeRequestFactory",
      "PinnedTransportDeps",
      "buildPinnedRequestOptions",
      "pinnedLookup",
      "rejectUnauthorized",
    ]) {
      assert.equal(
        indexSource.includes(hook),
        false,
        `index.ts must not mention ${hook}`,
      );
    }

    const transportSource = readFileSync(join(SRC_DIR, "transport.ts"), "utf8");
    assert.equal(
      /rejectUnauthorized\s*:/.test(transportSource),
      false,
      "transport must not set rejectUnauthorized",
    );
    assert.equal(
      /createPinnedNodeTransport\s*\(\s*deps/.test(transportSource),
      false,
    );
    assert.equal(transportSource.includes("NodeRequestFactory"), false);
    assert.equal(
      /export function createPinnedNodeTransport\s*\(\s*\)/.test(transportSource),
      true,
    );
  });
});

describe("secret material — repository scan", () => {
  it("contains no PEM private keys in package sources", () => {
    const privateKey = /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/;
    for (const { file, content } of allPackageSources()) {
      assert.equal(
        privateKey.test(content),
        false,
        `${file} contains private-key PEM material`,
      );
    }
  });
});
