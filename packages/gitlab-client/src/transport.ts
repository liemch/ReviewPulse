/**
 * GET-only HTTP transport.
 *
 * `fetch`/undici cannot be told "connect to this exact IP but present this
 * hostname for TLS" without a custom dispatcher, and the whole point of A1 is
 * that the socket goes to the address we validated. So the default transport
 * is a thin wrapper over the Node built-ins with a pinned `lookup` and an
 * explicit `servername`. No new runtime dependency, and TLS verification is
 * left at its secure default — there is no production option to disable it,
 * supply a custom CA, replace the lookup, or inject a raw request driver.
 */

import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

export type GitLabHttpRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Validated address from the SSRF guard; the socket must go here. */
  readonly pin: { readonly address: string; readonly family: 4 | 6 } | null;
};

export type GitLabHttpResponse = {
  readonly status: number;
  /** Lowercased header names; repeated values joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
};

export interface GitLabHttpTransport {
  send(request: GitLabHttpRequest): Promise<GitLabHttpResponse>;
}

function normalizeHeaders(
  raw: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Answers every DNS question for this request with the already-validated
 * address. Module-visible for same-package tests via relative import; not part
 * of the package public API.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    const wantsAll =
      typeof options === "object" && options !== null && options.all === true;
    if (wantsAll) {
      (callback as unknown as (
        err: null,
        addresses: { address: string; family: number }[],
      ) => void)(null, [{ address, family }]);
      return;
    }
    (callback as unknown as (
      err: null,
      address: string,
      family: number,
    ) => void)(null, address, family);
  };
}

/**
 * Options the production transport always sends to Node. Module-visible for
 * same-package tests; not part of the package public API. There is no caller
 * hook to replace `lookup`, `servername`, `ca`, or `rejectUnauthorized`.
 */
export function buildPinnedRequestOptions(
  request: GitLabHttpRequest,
  url: URL,
): https.RequestOptions {
  const isTls = url.protocol === "https:";
  return {
    method: "GET",
    headers: { ...request.headers },
    signal: request.signal,
    ...(request.pin === null
      ? {}
      : { lookup: pinnedLookup(request.pin.address, request.pin.family) }),
    // Keep the real hostname for SNI and certificate validation even though
    // the connection is dialed at the pinned address.
    ...(isTls ? { servername: stripBrackets(url.hostname) } : {}),
  };
}

/**
 * Production pinned transport. Takes no options — callers cannot swap the
 * request driver, CA, agent, lookup, or TLS verification settings.
 */
export function createPinnedNodeTransport(): GitLabHttpTransport {
  return {
    async send(request: GitLabHttpRequest): Promise<GitLabHttpResponse> {
      const url = new URL(request.url);
      const options = buildPinnedRequestOptions(request, url);
      const driver = url.protocol === "https:" ? https : http;

      return await new Promise<GitLabHttpResponse>((resolve, reject) => {
        const clientRequest = driver.request(url, options, (response) => {
          resolve({
            status: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            body: response,
          });
        });

        clientRequest.on("error", reject);
        clientRequest.end();
      });
    },
  };
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
