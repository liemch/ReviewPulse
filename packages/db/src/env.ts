/**
 * WP0 env shape checks only — does not implement crypto or sessions (WP1/WP3).
 * Never log secret values.
 */

export type EnvIssue = {
  key: string;
  message: string;
};

export type EnvCheckResult = {
  ok: boolean;
  issues: EnvIssue[];
};

function decodeBase64(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const buf = Buffer.from(padded, "base64");
    if (buf.length === 0 && value.length > 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Validate optional WP0 secret placeholders when present.
 * Empty values are allowed in WP0 (crypto/session not wired yet).
 */
export function validateWp0Env(
  env: Record<string, string | undefined>,
): EnvCheckResult {
  const issues: EnvIssue[] = [];

  const tokenKey = env.TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  if (tokenKey.length > 0) {
    const bytes = decodeBase64(tokenKey);
    if (!bytes) {
      issues.push({
        key: "TOKEN_ENCRYPTION_KEY",
        message: "must be valid base64",
      });
    } else if (bytes.length !== 32) {
      issues.push({
        key: "TOKEN_ENCRYPTION_KEY",
        message: "must decode to exactly 32 bytes",
      });
    }
  }

  const sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (sessionSecret.length > 0 && sessionSecret.length < 32) {
    issues.push({
      key: "SESSION_SECRET",
      message: "must be at least 32 characters when set",
    });
  }

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl.length > 0 && !databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    issues.push({
      key: "DATABASE_URL",
      message: "must start with postgresql:// or postgres://",
    });
  }

  return { ok: issues.length === 0, issues };
}

/** Safe summary for logs/tests — keys only, never values. */
export function summarizeEnvIssues(result: EnvCheckResult): string[] {
  return result.issues.map((i) => `${i.key}: ${i.message}`);
}
