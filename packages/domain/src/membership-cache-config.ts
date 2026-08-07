/** WP5 membership cache TTL — default 300s per M1 D6. */

export const DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS = 300;

export function parseMembershipCacheTtlSeconds(
  raw: string | undefined,
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "MEMBERSHIP_CACHE_TTL_SECONDS must be a positive integer",
    );
  }
  return parsed;
}

export function membershipCacheTtlFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return parseMembershipCacheTtlSeconds(env.MEMBERSHIP_CACHE_TTL_SECONDS);
}

/**
 * Denials are cached far more briefly than grants. GitLab answers 403/404 for
 * conditions that clear on their own (a project being moved, a secondary rate
 * limit), and a full-length denial would keep a project out of the list for
 * five minutes after access is back. Shortening it only costs extra probes —
 * it can never turn a denial into a grant.
 */
export const DEFAULT_MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS = 30;

export function parseMembershipCacheNegativeTtlSeconds(
  raw: string | undefined,
  positiveTtlSeconds = DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS,
): number {
  const fallback = Math.min(
    DEFAULT_MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS,
    positiveTtlSeconds,
  );
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS must be a positive integer",
    );
  }
  return Math.min(parsed, positiveTtlSeconds);
}

export function membershipCacheNegativeTtlFromEnv(
  env: Record<string, string | undefined> = process.env,
  positiveTtlSeconds = membershipCacheTtlFromEnv(env),
): number {
  return parseMembershipCacheNegativeTtlSeconds(
    env.MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS,
    positiveTtlSeconds,
  );
}
