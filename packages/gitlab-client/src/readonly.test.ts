/**
 * Read-only guarantee for the GitLab *read* surface.
 *
 * Write verbs are allowed only in `write-client.ts` (M2 mutations). Everything
 * else must remain GET-only so M1 sync and workspace reads cannot mutate GitLab
 * by accident.
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

/** Modules that intentionally issue GitLab mutations (M2). */
const WRITE_MODULES = new Set(["write-client.ts"]);

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
  it("contains no HTTP write method assignments outside write-client", () => {
    // Type unions may mention verbs; what must stay GET-only is any concrete
    // `method: "POST"` (etc.) assignment outside the write client.
    const writeMethodAssign = /method:\s*["'](POST|PUT|PATCH|DELETE)["']/;

    for (const { file, content } of productionSources()) {
      if (WRITE_MODULES.has(file)) {
        continue;
      }
      assert.equal(
        writeMethodAssign.test(content),
        false,
        `${file} assigns an HTTP write method`,
      );
    }
  });

  it("defaults the HTTP method to GET when omitted", () => {
    const transport = productionSources().find(
      (source) => source.file === "transport.ts",
    );
    assert.ok(transport);
    assert.match(transport.content, /method:\s*request\.method\s*\?\?\s*"GET"/);
  });

  it("keeps request-body send path out of read modules", () => {
    for (const { file, content } of productionSources()) {
      if (WRITE_MODULES.has(file) || file === "transport.ts" || file === "http.ts") {
        continue;
      }
      assert.equal(
        /\brequestBody\b|\.end\(JSON/.test(content),
        false,
        `${file} looks like it can send a request body`,
      );
    }
  });
});

describe("read-only guarantee — public surface", () => {
  it("exports no unexpected mutating factory or helper", () => {
    const mutating =
      /^(create|update|delete|remove|post|put|patch|approve|merge|comment|note|close|reopen|award|revoke)[A-Z]/;
    const allowedFactories = new Set([
      "createGitLabReadClient",
      "createGitLabWriteClient",
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

  it("gives the read client only read methods", () => {
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
      "getMergeRequest",
      "getMergeRequestApprovals",
      "getProject",
      "listAccessibleProjects",
      "listBranches",
      "listCommits",
      "listMergeRequestDiffs",
      "listMergeRequestPipelines",
      "listMergeRequests",
      "listProjectMergeRequests",
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
    const privateKey = /BEGIN (?:RSA |EC |OPENSSL |OPENSSH )?PRIVATE KEY/;
    for (const { file, content } of allPackageSources()) {
      assert.equal(
        privateKey.test(content),
        false,
        `${file} contains private-key PEM material`,
      );
    }
  });
});
