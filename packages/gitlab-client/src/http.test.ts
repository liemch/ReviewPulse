import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitLabAbortedError,
  GitLabForbiddenError,
  GitLabMalformedResponseError,
  GitLabNotFoundError,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabRateLimitedError,
  GitLabRedirectRejectedError,
  GitLabResponseTooLargeError,
  GitLabSsrfBlockedError,
  GitLabTimeoutError,
  GitLabUnauthorizedError,
  GitLabUnexpectedStatusError,
  GitLabUpstreamUnavailableError,
} from "./errors.js";
import {
  createRequestExecutor,
  parseRetryAfter,
  type RouteScope,
} from "./http.js";
import { resolveLimits, type ClientLimits } from "./limits.js";
import { createSsrfGuard, type DnsResolver } from "./ssrf.js";
import {
  createMockTransport,
  createSequenceTransport,
  jsonResponse,
  publicResolver,
  recordingSleep,
  sequenceResolver,
  testAuth,
  TEST_ORIGIN,
  TEST_TOKEN,
  type MockResponseSpec,
  type MockTransport,
  type RecordedSleep,
} from "./test-support.js";
import { createGitLabAllowlist } from "./url.js";

const USER_URL = new URL(`${TEST_ORIGIN}/api/v4/user`);

type Harness = {
  readonly transport: MockTransport;
  readonly sleeps: RecordedSleep[];
  run: (
    scope?: RouteScope,
    signal?: AbortSignal,
  ) => Promise<{ status: number; json: unknown }>;
};

function harness(
  specsOrTransport: readonly MockResponseSpec[] | MockTransport,
  overrides: Partial<ClientLimits> = {},
  resolver: DnsResolver = publicResolver(),
): Harness {
  const transport = Array.isArray(specsOrTransport)
    ? createSequenceTransport(specsOrTransport)
    : (specsOrTransport as MockTransport);
  const sleeps: RecordedSleep[] = [];

  const executor = createRequestExecutor({
    auth: testAuth(),
    ssrf: createSsrfGuard({
      allowlist: createGitLabAllowlist([TEST_ORIGIN]),
      resolve: resolver,
    }),
    transport,
    limits: resolveLimits(overrides),
    sleep: recordingSleep(sleeps),
    // Full jitter with random() === 1 yields the un-jittered exponential value,
    // which keeps backoff assertions exact instead of range-based.
    random: () => 1,
  });

  return {
    transport,
    sleeps,
    run: async (scope = "global", signal) =>
      await executor.requestJson(USER_URL, {
        scope,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}

describe("request executor — happy path", () => {
  it("returns parsed JSON and sends the PAT only in PRIVATE-TOKEN", async () => {
    const h = harness([jsonResponse({ id: 7 })]);
    const result = await h.run();

    assert.deepEqual(result.json, { id: 7 });

    const request = h.transport.requests[0];
    assert.ok(request);
    assert.equal(request.headers["private-token"], TEST_TOKEN);
    assert.equal(request.headers["accept"], "application/json");
    assert.equal(request.url.includes(TEST_TOKEN), false);
    assert.equal(request.url.includes("private_token"), false);
  });

  it("pins the socket to the validated address", async () => {
    const h = harness([jsonResponse({ id: 7 })]);
    await h.run();

    assert.deepEqual(h.transport.requests[0]?.pin, {
      address: "93.184.216.34",
      family: 4,
    });
  });
});

describe("request executor — status mapping", () => {
  const cases: ReadonlyArray<
    readonly [number, RouteScope, new (...args: never[]) => Error]
  > = [
    [401, "global", GitLabUnauthorizedError],
    [401, "project", GitLabUnauthorizedError],
    [403, "global", GitLabForbiddenError],
    [403, "project", GitLabProjectForbiddenError],
    [404, "global", GitLabNotFoundError],
    [404, "project", GitLabProjectNotFoundError],
    [400, "global", GitLabUnexpectedStatusError],
    [422, "project", GitLabUnexpectedStatusError],
    [301, "global", GitLabRedirectRejectedError],
    [302, "project", GitLabRedirectRejectedError],
  ];

  for (const [status, scope, expected] of cases) {
    it(`${status} on a ${scope} route is not retried`, async () => {
      const h = harness([{ status, body: "{}" }]);
      await assert.rejects(() => h.run(scope), expected);
      assert.equal(h.transport.requests.length, 1);
      assert.equal(h.sleeps.length, 0);
    });
  }

  it("never follows a redirect Location", async () => {
    const h = harness([
      {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
        body: "",
      },
    ]);
    await assert.rejects(() => h.run(), GitLabRedirectRejectedError);
    assert.equal(h.transport.requests.length, 1);
  });

  it("keeps a project 403 distinct from a bad credential", async () => {
    const transport = createMockTransport((request) =>
      request.url.includes("user")
        ? { status: 403, body: "{}" }
        : jsonResponse({}),
    );
    const h = harness(transport);
    await assert.rejects(() => h.run("project"), GitLabProjectForbiddenError);
    await assert.rejects(() => h.run("project"), (error: unknown) => {
      assert.equal(error instanceof GitLabUnauthorizedError, false);
      return true;
    });
  });
});

describe("request executor — retry budget", () => {
  it("retries 503 and then succeeds", async () => {
    const h = harness([
      { status: 503, body: "" },
      jsonResponse({ ok: true }),
    ]);
    const result = await h.run();

    assert.deepEqual(result.json, { ok: true });
    assert.equal(h.transport.requests.length, 2);
    assert.deepEqual(h.sleeps, [{ ms: 250 }]);
  });

  it("uses exponential backoff capped at backoffMaxMs", async () => {
    const h = harness(
      [
        { status: 503, body: "" },
        { status: 503, body: "" },
        { status: 503, body: "" },
        jsonResponse({ ok: true }),
      ],
      { backoffBaseMs: 4000, backoffMaxMs: 8000 },
    );
    await h.run();
    assert.deepEqual(h.sleeps, [{ ms: 4000 }, { ms: 8000 }, { ms: 8000 }]);
  });

  it("stops after maxAttempts including the first", async () => {
    const h = harness([
      { status: 503, body: "" },
      { status: 503, body: "" },
      { status: 503, body: "" },
      { status: 503, body: "" },
    ]);
    await assert.rejects(() => h.run(), GitLabUpstreamUnavailableError);

    assert.equal(h.transport.requests.length, 4);
    assert.equal(h.sleeps.length, 3);
  });

  it("retries transport failures such as a connection reset", async () => {
    const h = harness([
      { error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) },
      jsonResponse({ ok: true }),
    ]);
    await h.run();
    assert.equal(h.transport.requests.length, 2);
  });

  it("surfaces rate limiting, not unavailability, when 429 exhausts the budget", async () => {
    const h = harness([
      { status: 429, body: "" },
      { status: 429, body: "" },
      { status: 429, body: "" },
      { status: 429, body: "" },
    ]);
    await assert.rejects(() => h.run(), GitLabRateLimitedError);
  });

  it("honors Retry-After in seconds", async () => {
    const h = harness([
      { status: 429, headers: { "retry-after": "2" }, body: "" },
      jsonResponse({ ok: true }),
    ]);
    await h.run();
    assert.deepEqual(h.sleeps, [{ ms: 2000 }]);
  });

  it("refuses to sleep past the total budget", async () => {
    const h = harness(
      [{ status: 429, headers: { "retry-after": "120" }, body: "" }],
      { totalTimeoutMs: 3_000 },
    );
    await assert.rejects(() => h.run(), (error: unknown) => {
      assert.ok(error instanceof GitLabRateLimitedError);
      assert.equal(error.retryAfterMs, 120_000);
      return true;
    });

    // One attempt, and crucially no 120s sleep before failing.
    assert.equal(h.transport.requests.length, 1);
    assert.equal(h.sleeps.length, 0);
  });
});

describe("request executor — timeout and abort", () => {
  it("times out a hanging attempt and gives up within the total budget", async () => {
    const transport = createMockTransport(() => ({ hang: true }));
    const h = harness(transport, {
      attemptTimeoutMs: 20,
      totalTimeoutMs: 120,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    });

    await assert.rejects(() => h.run(), GitLabTimeoutError);
    assert.ok(h.transport.requests.length >= 1);
    assert.ok(h.transport.requests.length <= 4);
  });

  it("aborts immediately on the caller signal without retrying", async () => {
    const controller = new AbortController();
    const transport = createMockTransport(() => {
      controller.abort();
      return { hang: true };
    });
    const h = harness(transport, { attemptTimeoutMs: 5_000 });

    await assert.rejects(
      () => h.run("global", controller.signal),
      GitLabAbortedError,
    );
    assert.equal(h.transport.requests.length, 1);
    assert.equal(h.sleeps.length, 0);
  });

  it("refuses to start when the caller signal is already aborted", async () => {
    const h = harness([jsonResponse({})]);
    await assert.rejects(
      () => h.run("global", AbortSignal.abort()),
      GitLabAbortedError,
    );
    assert.equal(h.transport.requests.length, 0);
  });
});

describe("request executor — body handling", () => {
  it("rejects a body larger than the cap", async () => {
    const chunk = new Uint8Array(1024);
    const h = harness(
      [{ status: 200, chunks: [chunk, chunk, chunk] }],
      { maxResponseBytes: 2048 },
    );
    await assert.rejects(() => h.run(), GitLabResponseTooLargeError);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    let bodyRead = false;
    const transport = createMockTransport(() => ({
      status: 200,
      headers: { "content-length": "999999" },
      get chunks(): Uint8Array[] {
        bodyRead = true;
        return [new Uint8Array(1)];
      },
    }));
    const h = harness(transport, { maxResponseBytes: 1024 });

    await assert.rejects(() => h.run(), GitLabResponseTooLargeError);
    assert.equal(bodyRead, false);
  });

  it("rejects a non-JSON or empty body", async () => {
    for (const body of ["<html>nope</html>", "", "   "]) {
      const h = harness([{ status: 200, body }]);
      await assert.rejects(() => h.run(), GitLabMalformedResponseError, body);
    }
  });
});

describe("request executor — SSRF integration", () => {
  it("revalidates DNS on every attempt so rebinding is caught mid-retry", async () => {
    const resolver = sequenceResolver([
      [{ address: "93.184.216.34", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
    ]);
    const h = harness(
      [{ status: 503, body: "" }, jsonResponse({ ok: true })],
      {},
      resolver,
    );

    await assert.rejects(() => h.run(), GitLabSsrfBlockedError);
    // The second attempt never reached the transport.
    assert.equal(h.transport.requests.length, 1);
    assert.equal(resolver.calls, 2);
  });
});

describe("request executor — secret safety", () => {
  it("keeps the token out of error messages, context, and JSON output", async () => {
    const h = harness([{ status: 401, body: `{"message":"${TEST_TOKEN}"}` }]);

    await assert.rejects(() => h.run(), (error: unknown) => {
      assert.ok(error instanceof GitLabUnauthorizedError);
      const serialized = JSON.stringify({
        message: error.message,
        code: error.code,
        context: error.context,
        stack: error.stack,
      });
      assert.equal(serialized.includes(TEST_TOKEN), false);
      assert.equal(serialized.includes("glpat-"), false);
      return true;
    });
  });

  it("redacts a token accidentally placed in error context", async () => {
    const error = new GitLabUnauthorizedError({
      privateToken: TEST_TOKEN,
      nested: { accessToken: TEST_TOKEN },
    });
    assert.equal(JSON.stringify(error.context).includes(TEST_TOKEN), false);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    assert.equal(parseRetryAfter("5"), 5000);
    assert.equal(parseRetryAfter(" 0 "), 0);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("2026-08-05T00:00:00Z");
    const later = new Date(now + 30_000).toUTCString();
    assert.equal(parseRetryAfter(later, now), 30_000);
  });

  it("never returns a negative wait for a past date", () => {
    const now = Date.parse("2026-08-05T00:00:00Z");
    const earlier = new Date(now - 30_000).toUTCString();
    assert.equal(parseRetryAfter(earlier, now), 0);
  });

  it("ignores values it cannot parse", () => {
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter(""), null);
    assert.equal(parseRetryAfter("soon"), null);
    assert.equal(parseRetryAfter("-5"), null);
  });
});
