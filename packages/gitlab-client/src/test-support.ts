/**
 * Test doubles. Not exported from the package index — these exist so the
 * security tests can drive the client without touching the network or DNS.
 */

import { createPatAuthAdapter, type GitLabAuthAdapter } from "./auth.js";
import type {
  GitLabHttpRequest,
  GitLabHttpResponse,
  GitLabHttpTransport,
} from "./transport.js";
import type { DnsResolver, ResolvedAddress } from "./ssrf.js";

export const TEST_ORIGIN = "https://gitlab.example.com";
export const TEST_TOKEN = "glpat-SUPERSECRETTOKENVALUE";

export type MockResponseSpec = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Raw chunks, for size-cap tests that must not buffer a real 8 MiB. */
  readonly chunks?: readonly Uint8Array[];
  /** Transport-level failure, e.g. ECONNRESET. */
  readonly error?: Error;
  /** Never settles until the request signal aborts. */
  readonly hang?: boolean;
};

export type RecordedRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly pin: GitLabHttpRequest["pin"];
};

export type MockTransport = GitLabHttpTransport & {
  readonly requests: RecordedRequest[];
};

function toResponse(spec: MockResponseSpec): GitLabHttpResponse {
  return {
    status: spec.status ?? 200,
    headers: spec.headers ?? {},
    // Chunks are resolved lazily: a generator body does not run until it is
    // iterated, which lets tests assert that an oversized Content-Length is
    // rejected before the body is ever touched.
    body: (async function* stream() {
      const chunks = spec.chunks ?? [
        new TextEncoder().encode(spec.body ?? "{}"),
      ];
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
  };
}

export function createMockTransport(
  handler: (
    request: RecordedRequest,
    callIndex: number,
  ) => MockResponseSpec | Promise<MockResponseSpec>,
): MockTransport {
  const requests: RecordedRequest[] = [];

  return {
    requests,
    async send(request: GitLabHttpRequest): Promise<GitLabHttpResponse> {
      const recorded: RecordedRequest = {
        url: request.url,
        headers: { ...request.headers },
        pin: request.pin,
      };
      requests.push(recorded);

      const spec = await handler(recorded, requests.length - 1);

      if (spec.hang === true) {
        return await new Promise<GitLabHttpResponse>((_resolve, reject) => {
          const onAbort = (): void =>
            reject(new Error("aborted by request signal"));
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (spec.error !== undefined) {
        throw spec.error;
      }
      return toResponse(spec);
    },
  };
}

export function createSequenceTransport(
  specs: readonly MockResponseSpec[],
): MockTransport {
  return createMockTransport((_request, index) => {
    const spec = specs[index];
    if (spec === undefined) {
      throw new Error(`mock transport: unexpected request #${index + 1}`);
    }
    return spec;
  });
}

export function jsonResponse(
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): MockResponseSpec {
  return { status: 200, headers, body: JSON.stringify(value) };
}

/** Fixed resolver so no test ever performs a real DNS query. */
export function staticResolver(
  map: Readonly<Record<string, readonly ResolvedAddress[]>>,
): DnsResolver {
  return async (hostname) => {
    const answers = map[hostname];
    if (answers === undefined) {
      throw new Error("ENOTFOUND");
    }
    return [...answers];
  };
}

/** Answers differently on each call, to model a rebinding resolver. */
export function sequenceResolver(
  answers: ReadonlyArray<readonly ResolvedAddress[]>,
): DnsResolver & { calls: number } {
  const resolver = async (): Promise<ResolvedAddress[]> => {
    const index = Math.min(resolver.calls, answers.length - 1);
    resolver.calls += 1;
    const answer = answers[index];
    if (answer === undefined) {
      throw new Error("ENOTFOUND");
    }
    return [...answer];
  };
  resolver.calls = 0;
  return resolver;
}

/** 93.184.216.34 is a genuinely public unicast address, unlike TEST-NET ranges. */
export const PUBLIC_ADDRESS = "93.184.216.34";

export function publicResolver(hostname = "gitlab.example.com"): DnsResolver {
  return staticResolver({
    [hostname]: [{ address: PUBLIC_ADDRESS, family: 4 }],
  });
}

export function testAuth(token: string = TEST_TOKEN): GitLabAuthAdapter {
  return createPatAuthAdapter(() => token);
}

export type RecordedSleep = { readonly ms: number };

export function recordingSleep(sleeps: RecordedSleep[]): (
  ms: number,
  signal?: AbortSignal,
) => Promise<void> {
  return async (ms, signal) => {
    if (signal?.aborted === true) {
      throw new Error("aborted during backoff");
    }
    sleeps.push({ ms });
  };
}
