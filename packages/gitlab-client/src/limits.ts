/** Locked budgets from A7/A8 and the pagination section of the WP2 plan. */

export type ClientLimits = {
  /** Counts the first try, so 4 means at most 3 retries. */
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  /** Wall clock for one page request across all attempts and backoff sleeps. */
  readonly totalTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly maxResponseBytes: number;
  readonly perPage: number;
  readonly maxPages: number;
  readonly maxItems: number;
};

export const DEFAULT_LIMITS: ClientLimits = {
  maxAttempts: 4,
  attemptTimeoutMs: 15_000,
  totalTimeoutMs: 45_000,
  backoffBaseMs: 250,
  backoffMaxMs: 8_000,
  maxResponseBytes: 8 * 1024 * 1024,
  perPage: 100,
  maxPages: 100,
  maxItems: 10_000,
};

export function resolveLimits(overrides?: Partial<ClientLimits>): ClientLimits {
  return { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
}
