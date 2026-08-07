/**
 * GET-only request executor: SSRF re-check, auth header, per-attempt and total
 * deadlines, streamed size cap, status mapping, and the A8 retry budget.
 *
 * The SSRF check runs inside the attempt loop on purpose. A retry is a new
 * connection, so it gets a new resolution and a new validation instead of
 * reusing a decision that was true 30 seconds ago.
 */

import { PRIVATE_TOKEN_HEADER, type GitLabAuthAdapter } from "./auth.js";
import {
  GitLabAbortedError,
  GitLabError,
  GitLabForbiddenError,
  GitLabMalformedResponseError,
  GitLabNotFoundError,
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabRateLimitedError,
  GitLabRedirectRejectedError,
  GitLabResponseTooLargeError,
  GitLabTimeoutError,
  GitLabUnauthorizedError,
  GitLabUnexpectedStatusError,
  GitLabUpstreamUnavailableError,
  isGitLabError,
} from "./errors.js";
import type { ClientLimits } from "./limits.js";
import type { SsrfGuard } from "./ssrf.js";
import type { GitLabHttpResponse, GitLabHttpTransport } from "./transport.js";

export const USER_AGENT = "ReviewPulse-GitLabReadClient/1" as const;

/** Project-scoped routes keep 403/404 distinct from a bad credential (D4). */
export type RouteScope = "project" | "global";

export type RawResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
};

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type RequestExecutorOptions = {
  readonly auth: GitLabAuthAdapter;
  readonly ssrf: SsrfGuard;
  readonly transport: GitLabHttpTransport;
  readonly limits: ClientLimits;
  readonly sleep?: SleepFn;
  readonly random?: () => number;
};

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new GitLabAbortedError({ reason: "caller_abort" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new GitLabAbortedError({ reason: "caller_abort" }));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export type MutationHttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface GitLabRequestExecutor {
  requestJson(
    url: URL,
    options: { scope: RouteScope; signal?: AbortSignal },
  ): Promise<RawResponse>;

  /**
   * Mutation requests. Retries only on 429 (request not accepted). Transport
   * errors after send fail closed — never auto-retry POST/PUT (no double-submit).
   */
  requestMutationJson(
    url: URL,
    options: {
      scope: RouteScope;
      signal?: AbortSignal;
      method: MutationHttpMethod;
      body?: Record<string, unknown>;
    },
  ): Promise<RawResponse>;
}

export function createRequestExecutor(
  options: RequestExecutorOptions,
): GitLabRequestExecutor {
  const { auth, ssrf, transport, limits } = options;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  async function attempt(
    url: URL,
    scope: RouteScope,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    method?: MutationHttpMethod,
    bodyJson?: Record<string, unknown>,
  ): Promise<RawResponse> {
    const decision = await ssrf.check(url);
    const credential = await auth.getCredential(callerSignal);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await transport.send({
        url: url.toString(),
        headers: {
          // A5: the PAT travels in this header and nowhere else. It is never
          // put in the URL, where it would land in proxy and access logs.
          [PRIVATE_TOKEN_HEADER]: credential.token,
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(bodyJson === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        signal: controller.signal,
        pin: {
          address: decision.pinnedAddress,
          family: decision.pinnedFamily,
        },
        ...(method === undefined ? {} : { method }),
        ...(bodyJson === undefined
          ? {}
          : { body: JSON.stringify(bodyJson) }),
      });
      return await handleResponse(response, scope, limits);
    } catch (error) {
      if (isGitLabError(error)) {
        throw error;
      }
      if (callerSignal?.aborted === true) {
        throw new GitLabAbortedError({ reason: "caller_abort" });
      }
      if (timedOut) {
        throw new GitLabTimeoutError({ reason: "attempt_timeout" });
      }
      // Connection reset, TLS failure, DNS error after connect: retryable, and
      // the underlying message is dropped so it cannot echo request details.
      throw new GitLabUpstreamUnavailableError({ reason: "transport_error" });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  return {
    async requestJson(url, { scope, signal }): Promise<RawResponse> {
      const deadline = Date.now() + limits.totalTimeoutMs;
      let lastError: GitLabError | null = null;

      for (let attemptNo = 1; attemptNo <= limits.maxAttempts; attemptNo += 1) {
        throwIfAborted(signal);

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw lastError ?? new GitLabTimeoutError({ reason: "total_budget" });
        }

        try {
          return await attempt(
            url,
            scope,
            signal,
            Math.min(limits.attemptTimeoutMs, remaining),
          );
        } catch (error) {
          if (!isRetryable(error)) {
            throw error;
          }
          lastError = error;
          if (attemptNo >= limits.maxAttempts) {
            throw error;
          }

          const delayMs = backoffFor(error, attemptNo, limits, random);
          // Sleeping past the total budget only converts a useful error into a
          // timeout, so give up now and surface the real reason.
          if (Date.now() + delayMs >= deadline) {
            throw error;
          }
          await sleep(delayMs, signal);
        }
      }

      throw lastError ?? new GitLabUpstreamUnavailableError({
        reason: "retry_budget_exhausted",
      });
    },

    async requestMutationJson(url, { scope, signal, method, body }) {
      const deadline = Date.now() + limits.totalTimeoutMs;
      let lastError: GitLabError | null = null;

      for (let attemptNo = 1; attemptNo <= limits.maxAttempts; attemptNo += 1) {
        throwIfAborted(signal);

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw lastError ?? new GitLabTimeoutError({ reason: "total_budget" });
        }

        try {
          return await attempt(
            url,
            scope,
            signal,
            Math.min(limits.attemptTimeoutMs, remaining),
            method,
            body,
          );
        } catch (error) {
          // Mutations: only retry explicit 429 (GitLab rejected before accept).
          // Transport/timeout after send is fail-closed — do not double-submit.
          if (!(error instanceof GitLabRateLimitedError)) {
            throw error;
          }
          lastError = error;
          if (attemptNo >= limits.maxAttempts) {
            throw error;
          }
          const delayMs = backoffFor(error, attemptNo, limits, random);
          if (Date.now() + delayMs >= deadline) {
            throw error;
          }
          await sleep(delayMs, signal);
        }
      }

      throw lastError ?? new GitLabUpstreamUnavailableError({
        reason: "retry_budget_exhausted",
      });
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new GitLabAbortedError({ reason: "caller_abort" });
  }
}

function isRetryable(error: unknown): error is GitLabError {
  return (
    error instanceof GitLabRateLimitedError ||
    error instanceof GitLabUpstreamUnavailableError ||
    error instanceof GitLabTimeoutError
  );
}

function backoffFor(
  error: GitLabError,
  attemptNo: number,
  limits: ClientLimits,
  random: () => number,
): number {
  const retryAfterMs =
    error instanceof GitLabRateLimitedError ||
    error instanceof GitLabUpstreamUnavailableError
      ? error.retryAfterMs
      : null;

  if (retryAfterMs !== null && retryAfterMs >= 0) {
    return retryAfterMs;
  }

  const exponential = Math.min(
    limits.backoffMaxMs,
    limits.backoffBaseMs * 2 ** (attemptNo - 1),
  );
  return Math.floor(random() * exponential);
}

/** RFC 7231: delta-seconds or an HTTP-date. Anything else is ignored. */
export function parseRetryAfter(
  value: string | undefined,
  now: number = Date.now(),
): number | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // All three HTTP-date formats start with a weekday name. Without this gate
  // `Date.parse` happily reads junk like "-5" as a year and yields a wait.
  if (!/^[A-Za-z]{3,9},?\s/.test(trimmed)) {
    return null;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now);
}

async function handleResponse(
  response: GitLabHttpResponse,
  scope: RouteScope,
  limits: ClientLimits,
): Promise<RawResponse> {
  const { status, headers } = response;

  if (status >= 200 && status < 300) {
    const text = await readBodyWithCap(response, limits.maxResponseBytes);
    return { status, headers, json: parseJson(text) };
  }

  // Error bodies are discarded unread: a GitLab error page can echo request
  // details, and nothing downstream needs it.
  await discardBody(response);

  if (status >= 300 && status < 400) {
    throw new GitLabRedirectRejectedError({ status });
  }
  if (status === 401) {
    throw new GitLabUnauthorizedError({ status });
  }
  if (status === 403) {
    throw scope === "project"
      ? new GitLabProjectForbiddenError({ status })
      : new GitLabForbiddenError({ status });
  }
  if (status === 404) {
    throw scope === "project"
      ? new GitLabProjectNotFoundError({ status })
      : new GitLabNotFoundError({ status });
  }
  if (status === 429) {
    throw new GitLabRateLimitedError(parseRetryAfter(headers["retry-after"]), {
      status,
    });
  }
  if (status === 408) {
    throw new GitLabTimeoutError({ status, reason: "upstream_request_timeout" });
  }
  if (status >= 500) {
    throw new GitLabUpstreamUnavailableError(
      { status },
      parseRetryAfter(headers["retry-after"]),
    );
  }
  throw new GitLabUnexpectedStatusError(status, { status });
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) {
    throw new GitLabMalformedResponseError({ reason: "empty_body" });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitLabMalformedResponseError({ reason: "invalid_json" });
  }
}

type MaybeDestroyable = { destroy?: (error?: Error) => void };

function destroyBody(response: GitLabHttpResponse): void {
  const body = response.body as unknown as MaybeDestroyable;
  if (typeof body.destroy === "function") {
    body.destroy();
  }
}

async function discardBody(response: GitLabHttpResponse): Promise<void> {
  const body = response.body as unknown as MaybeDestroyable;
  if (typeof body.destroy === "function") {
    body.destroy();
    return;
  }
  try {
    // Breaking out of for-await closes the iterator. Any failure here is
    // swallowed so it cannot mask the status-derived error being thrown.
    for await (const chunk of response.body) {
      void chunk;
      break;
    }
  } catch {
    /* ignored */
  }
}

/**
 * Streams the body while counting bytes and stops the moment the cap is
 * exceeded, so an 8 GiB response cannot be buffered before we notice (A7).
 */
async function readBodyWithCap(
  response: GitLabHttpResponse,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers["content-length"];
  if (declared !== undefined && /^\d+$/.test(declared.trim())) {
    if (Number(declared.trim()) > maxBytes) {
      destroyBody(response);
      throw new GitLabResponseTooLargeError({ reason: "content_length" });
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      destroyBody(response);
      throw new GitLabResponseTooLargeError({ reason: "body_bytes" });
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}
