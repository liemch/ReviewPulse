/**
 * Focused tests for `createPinnedNodeTransport`.
 *
 * Production `createPinnedNodeTransport()` takes no hooks. Option-shape checks
 * import module-private helpers via relative paths. The trusted TLS smoke
 * spawns a child with `NODE_EXTRA_CA_CERTS` so verification still goes through
 * the real production transport + Node trust store (plus the ephemeral test
 * CA), never through a request-factory or `rejectUnauthorized=false`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createPatAuthAdapter, PRIVATE_TOKEN_HEADER } from "./auth.js";
import {
  GitLabRedirectRejectedError,
  GitLabResponseTooLargeError,
  GitLabUnauthorizedError,
} from "./errors.js";
import { createRequestExecutor, type RouteScope } from "./http.js";
import { resolveLimits } from "./limits.js";
import type { SsrfGuard } from "./ssrf.js";
import {
  createEphemeralTlsMaterial,
  requireOpenSslOrExplain,
  WP2_TEST_HOSTNAME,
  WP2_TEST_PINNED_IP,
  type EphemeralTlsMaterial,
} from "./test-tls-material.js";
import {
  buildPinnedRequestOptions,
  createPinnedNodeTransport,
  pinnedLookup,
  type GitLabHttpRequest,
} from "./transport.js";
import { originOf } from "./url.js";

const TEST_TOKEN = "glpat-TRANSPORTSECRETTOKEN";
const PIN = { address: "203.0.113.50", family: 4 as const };
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Test-only SSRF stub. Production policy always denies loopback, so throwaway
 * local servers cannot go through `createSsrfGuard`. Real SSRF policy lives in
 * `ssrf.test.ts`.
 */
function localPinGuard(): SsrfGuard {
  return {
    async check(url) {
      const defaultPort = url.protocol === "https:" ? 443 : 80;
      return {
        origin: originOf(url),
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? defaultPort : Number(url.port),
        protocol: url.protocol as "http:" | "https:",
        pinnedAddress: WP2_TEST_PINNED_IP,
        pinnedFamily: 4,
        validatedAddresses: [WP2_TEST_PINNED_IP],
      };
    },
    assertSameOrigin() {
      /* no-op */
    },
  };
}

function captureLookup(
  lookup: NonNullable<https.RequestOptions["lookup"]>,
  hostname: string,
  all = false,
): Promise<
  | { address: string; family: number }
  | { address: string; family: number }[]
> {
  return new Promise((resolve, reject) => {
    lookup(
      hostname,
      all ? { all: true, family: 0 } : { family: 0 },
      ((
        err: NodeJS.ErrnoException | null,
        address: string | { address: string; family: number }[],
        family?: number,
      ) => {
        if (err) {
          reject(err);
          return;
        }
        if (Array.isArray(address)) {
          resolve(address);
          return;
        }
        resolve({ address, family: family ?? 4 });
      }) as Parameters<typeof lookup>[2],
    );
  });
}

function headerValue(
  headers: https.RequestOptions["headers"],
  name: string,
): string | undefined {
  if (headers === undefined || Array.isArray(headers)) {
    return undefined;
  }
  const bag = headers as Record<string, unknown>;
  const value = bag[name];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  return undefined;
}

describe("pinnedLookup (module-internal)", () => {
  it("always returns the validated IP, ignoring the queried hostname", async () => {
    const lookup = pinnedLookup(PIN.address, PIN.family);

    assert.deepEqual(await captureLookup(lookup, "evil.example.com"), {
      address: PIN.address,
      family: 4,
    });
    assert.deepEqual(await captureLookup(lookup, "169.254.169.254"), {
      address: PIN.address,
      family: 4,
    });
    assert.deepEqual(await captureLookup(lookup, "gitlab.example.com", true), [
      { address: PIN.address, family: 4 },
    ]);
  });
});

describe("buildPinnedRequestOptions (module-internal)", () => {
  it("forces GET, pins lookup, and keeps the hostname for TLS SNI", () => {
    const signal = new AbortController().signal;
    const request: GitLabHttpRequest = {
      url: `https://${WP2_TEST_HOSTNAME}/api/v4/user`,
      headers: {
        [PRIVATE_TOKEN_HEADER]: TEST_TOKEN,
        accept: "application/json",
      },
      signal,
      pin: PIN,
    };
    const options = buildPinnedRequestOptions(request, new URL(request.url));

    assert.equal(options.method, "GET");
    assert.equal(options.servername, WP2_TEST_HOSTNAME);
    assert.notEqual(options.servername, PIN.address);
    assert.equal(typeof options.lookup, "function");
    assert.equal(options.signal, signal);
    assert.equal(headerValue(options.headers, PRIVATE_TOKEN_HEADER), TEST_TOKEN);
    assert.equal(
      Object.prototype.hasOwnProperty.call(options, "rejectUnauthorized"),
      false,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(options, "ca"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options, "agent"), false);

    assert.ok(options.lookup);
    return captureLookup(options.lookup, "rebinding.evil.test").then((resolved) => {
      assert.deepEqual(resolved, { address: PIN.address, family: 4 });
    });
  });

  it("omits servername for plain HTTP and still pins lookup", () => {
    const options = buildPinnedRequestOptions(
      {
        url: "http://gitlab.example.com/api/v4/user",
        headers: {},
        signal: new AbortController().signal,
        pin: PIN,
      },
      new URL("http://gitlab.example.com/api/v4/user"),
    );
    assert.equal(options.method, "GET");
    assert.equal(options.servername, undefined);
    assert.equal(typeof options.lookup, "function");
  });

  it("does not install a lookup when no pin is provided", () => {
    const options = buildPinnedRequestOptions(
      {
        url: "https://gitlab.example.com/api/v4/user",
        headers: {},
        signal: new AbortController().signal,
        pin: null,
      },
      new URL("https://gitlab.example.com/api/v4/user"),
    );
    assert.equal(options.lookup, undefined);
    assert.equal(options.servername, "gitlab.example.com");
  });
});

describe("createPinnedNodeTransport — public constructor", () => {
  it("takes no configuration arguments", () => {
    assert.equal(createPinnedNodeTransport.length, 0);
    const transport = createPinnedNodeTransport();
    assert.equal(typeof transport.send, "function");
  });
});

describe("createPinnedNodeTransport — local HTTP smoke", () => {
  let server: http.Server;
  let port: number;
  let hits: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
  }>;

  before(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
      });
      if (req.url?.startsWith("/redirect")) {
        res.writeHead(302, {
          location: "http://169.254.169.254/latest/meta-data/",
        });
        res.end();
        return;
      }
      if (req.url?.startsWith("/hang")) {
        return;
      }
      if (req.url?.startsWith("/large")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"pad":"');
        res.write("x".repeat(4096));
        res.end('"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("does not follow redirects — returns 302 with a single hit", async () => {
    hits.length = 0;
    const response = await createPinnedNodeTransport().send({
      url: `http://127.0.0.1:${port}/redirect`,
      headers: { [PRIVATE_TOKEN_HEADER]: TEST_TOKEN },
      signal: new AbortController().signal,
      pin: { address: "127.0.0.1", family: 4 },
    });

    assert.equal(response.status, 302);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.method, "GET");
    assert.equal(hits[0]?.headers[PRIVATE_TOKEN_HEADER], TEST_TOKEN);
    assert.equal(hits[0]?.url.includes(TEST_TOKEN), false);
  });

  it("aborts an in-flight request when the caller signal fires", async () => {
    const controller = new AbortController();
    const pending = createPinnedNodeTransport().send({
      url: `http://127.0.0.1:${port}/hang`,
      headers: {},
      signal: controller.signal,
      pin: { address: "127.0.0.1", family: 4 },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(JSON.stringify(error).includes(TEST_TOKEN), false);
      return true;
    });
  });

  it("keeps the PAT in PRIVATE-TOKEN only through the executor", async () => {
    hits.length = 0;
    const executor = createRequestExecutor({
      auth: createPatAuthAdapter(() => TEST_TOKEN),
      ssrf: localPinGuard(),
      transport: createPinnedNodeTransport(),
      limits: resolveLimits({
        attemptTimeoutMs: 2_000,
        totalTimeoutMs: 5_000,
        maxAttempts: 1,
      }),
    });

    const result = await executor.requestJson(
      new URL(`http://127.0.0.1:${port}/api/v4/user`),
      { scope: "global" as RouteScope },
    );
    assert.deepEqual(result.json, { ok: true });
    assert.equal(hits[0]?.method, "GET");
    assert.equal(hits[0]?.headers[PRIVATE_TOKEN_HEADER], TEST_TOKEN);
    assert.equal(hits[0]?.url.includes(TEST_TOKEN), false);
    assert.equal(hits[0]?.url.toLowerCase().includes("token"), false);
  });

  it("rejects an oversized body and surfaces a safe error", async () => {
    const executor = createRequestExecutor({
      auth: createPatAuthAdapter(() => TEST_TOKEN),
      ssrf: localPinGuard(),
      transport: createPinnedNodeTransport(),
      limits: resolveLimits({
        maxResponseBytes: 1024,
        maxAttempts: 1,
        attemptTimeoutMs: 2_000,
        totalTimeoutMs: 5_000,
      }),
    });

    await assert.rejects(
      () =>
        executor.requestJson(new URL(`http://127.0.0.1:${port}/large`), {
          scope: "global",
        }),
      (error: unknown) => {
        assert.ok(error instanceof GitLabResponseTooLargeError);
        assert.equal(JSON.stringify(error.context).includes(TEST_TOKEN), false);
        return true;
      },
    );
  });

  it("maps a 302 through the executor without following Location", async () => {
    hits.length = 0;
    const executor = createRequestExecutor({
      auth: createPatAuthAdapter(() => TEST_TOKEN),
      ssrf: localPinGuard(),
      transport: createPinnedNodeTransport(),
      limits: resolveLimits({ maxAttempts: 1 }),
    });

    await assert.rejects(
      () =>
        executor.requestJson(new URL(`http://127.0.0.1:${port}/redirect`), {
          scope: "global",
        }),
      GitLabRedirectRejectedError,
    );
    assert.equal(hits.length, 1);
  });
});

describe("createPinnedNodeTransport — abort during body read", () => {
  it("stops an open body when the request signal aborts mid-stream", async () => {
    let server: http.Server | undefined;
    try {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write("chunk-one\n");
      });
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      const controller = new AbortController();

      const response = await createPinnedNodeTransport().send({
        url: `http://127.0.0.1:${port}/stream`,
        headers: {},
        signal: controller.signal,
        pin: { address: "127.0.0.1", family: 4 },
      });

      const iterator = response.body[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.done, false);
      controller.abort();

      await assert.rejects(async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            throw new Error("stream ended without abort error");
          }
        }
      }, (error: unknown) => error instanceof Error);
    } finally {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
    }
  });
});

describe("createPinnedNodeTransport — local TLS smoke", () => {
  const openssl = requireOpenSslOrExplain();

  if (typeof openssl === "object") {
    it(`NOT RUN — ${openssl.notRun}`, { skip: true }, () => {
      /* documented local skip; CI fails hard via requireOpenSslOrExplain */
    });
    return;
  }

  let material: EphemeralTlsMaterial;
  let server: https.Server;
  let port: number;
  let observedSni: string | undefined;
  let hits: Array<{ method: string; url: string; hasToken: boolean }>;

  before(async () => {
    material = await createEphemeralTlsMaterial();
    hits = [];
    server = https.createServer(
      {
        key: material.serverKeyPem,
        cert: material.serverCertPem,
        ca: material.caCertPem,
      },
      (req, res) => {
        const socket = req.socket as Duplex & { servername?: string };
        observedSni = socket.servername;
        hits.push({
          method: req.method ?? "",
          url: req.url ?? "",
          hasToken: req.headers[PRIVATE_TOKEN_HEADER] === TEST_TOKEN,
        });
        if (req.url === "/api/v4/user") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: 1, username: "tls-smoke" }));
          return;
        }
        if (req.url === "/unauthorized") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: TEST_TOKEN }));
          return;
        }
        res.writeHead(404);
        res.end();
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, WP2_TEST_PINNED_IP, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await material.cleanup();
  });

  it("rejects the throwaway cert under the default system trust store", async () => {
    // Production transport, no CA injection, no rejectUnauthorized=false.
    await assert.rejects(
      () =>
        createPinnedNodeTransport().send({
          url: `https://${WP2_TEST_HOSTNAME}:${port}/api/v4/user`,
          headers: { [PRIVATE_TOKEN_HEADER]: TEST_TOKEN },
          signal: new AbortController().signal,
          pin: { address: WP2_TEST_PINNED_IP, family: 4 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const text = `${error.name}:${error.message}:${String((error as { code?: string }).code)}`;
        assert.match(
          text,
          /UNABLE_TO_VERIFY|CERT|unable to verify|certificate/i,
        );
        assert.equal(text.includes(TEST_TOKEN), false);
        return true;
      },
    );
  });

  it("dials the pinned IP with hostname SNI via production transport + NODE_EXTRA_CA_CERTS", async () => {
    hits.length = 0;
    observedSni = undefined;

    const childPath = join(HERE, "tls-smoke-child.ts");
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", childPath],
        {
          env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: material.caCertPath,
            WP2_TLS_SMOKE_URL: `https://${WP2_TEST_HOSTNAME}:${port}/api/v4/user`,
            WP2_TLS_SMOKE_PIN: WP2_TEST_PINNED_IP,
            WP2_TLS_SMOKE_TOKEN: TEST_TOKEN,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `tls-smoke-child exited ${code}: ${stderr
                .split(TEST_TOKEN)
                .join("[REDACTED]")}`,
            ),
          );
          return;
        }
        resolve(code ?? 1);
      });
    });

    assert.equal(exitCode, 0);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.method, "GET");
    assert.equal(hits[0]?.hasToken, true);
    assert.equal(hits[0]?.url.includes(TEST_TOKEN), false);
    assert.equal(observedSni, WP2_TEST_HOSTNAME);
    assert.notEqual(observedSni, WP2_TEST_PINNED_IP);
  });

  it("keeps PAT out of TLS and HTTP error paths with the production transport", async () => {
    await assert.rejects(
      () =>
        createPinnedNodeTransport().send({
          url: `https://${WP2_TEST_HOSTNAME}:${port}/unauthorized`,
          headers: { [PRIVATE_TOKEN_HEADER]: TEST_TOKEN },
          signal: new AbortController().signal,
          pin: { address: WP2_TEST_PINNED_IP, family: 4 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(String(error.message).includes(TEST_TOKEN), false);
        assert.equal(String(error.stack ?? "").includes(TEST_TOKEN), false);
        return true;
      },
    );

    const httpServer = http.createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: TEST_TOKEN }));
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const httpPort = (httpServer.address() as AddressInfo).port;
      const executor = createRequestExecutor({
        auth: createPatAuthAdapter(() => TEST_TOKEN),
        ssrf: localPinGuard(),
        transport: createPinnedNodeTransport(),
        limits: resolveLimits({ maxAttempts: 1 }),
      });
      await assert.rejects(
        () =>
          executor.requestJson(
            new URL(`http://127.0.0.1:${httpPort}/unauthorized`),
            { scope: "global" },
          ),
        (error: unknown) => {
          assert.ok(error instanceof GitLabUnauthorizedError);
          const serialized = JSON.stringify({
            message: error.message,
            code: error.code,
            context: error.context,
          });
          assert.equal(serialized.includes(TEST_TOKEN), false);
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  });
});
