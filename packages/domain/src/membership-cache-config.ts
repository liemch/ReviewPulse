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
