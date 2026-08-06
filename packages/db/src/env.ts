/**
 * Env shape checks — never log or embed secret values.
 *
 * - `validateWp0Env`: optional placeholders (empty allowed).
 * - `validateRuntimeEnv`: WP3+ required fields for running web/worker.
 */

export type EnvIssue = {
  key: string;
  message: string;
};

export type EnvCheckResult = {
  ok: boolean;
  issues: EnvIssue[];
  warnings: EnvIssue[];
};

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_VERSION_LABEL = /^v([1-9][0-9]*)$/;

function decodeCanonicalKey(value: string): Uint8Array | null {
  if (!STANDARD_BASE64.test(value)) {
    return null;
  }
  try {
    const buf = Buffer.from(value, "base64");
    if (buf.length === 0 || buf.toString("base64") !== value) {
      return null;
    }
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
    const bytes = decodeCanonicalKey(tokenKey);
    if (!bytes) {
      issues.push({
        key: "TOKEN_ENCRYPTION_KEY",
        message: "must be canonical standard base64",
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
  if (
    databaseUrl.length > 0 &&
    !databaseUrl.startsWith("postgresql://") &&
    !databaseUrl.startsWith("postgres://")
  ) {
    issues.push({
      key: "DATABASE_URL",
      message: "must start with postgresql:// or postgres://",
    });
  }

  return { ok: issues.length === 0, issues, warnings: [] };
}

/**
 * WP3+ runtime preflight — every required key checked; all issues returned
 * together. Messages never include secret values.
 */
export function validateRuntimeEnv(
  env: Record<string, string | undefined>,
): EnvCheckResult {
  const issues: EnvIssue[] = [];
  const warnings: EnvIssue[] = [];

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (databaseUrl.length === 0) {
    issues.push({ key: "DATABASE_URL", message: "required" });
  } else if (
    !databaseUrl.startsWith("postgresql://") &&
    !databaseUrl.startsWith("postgres://")
  ) {
    issues.push({
      key: "DATABASE_URL",
      message: "must start with postgresql:// or postgres://",
    });
  }

  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length === 0) {
    issues.push({ key: "SESSION_SECRET", message: "required" });
  } else if (sessionSecret.length < 32) {
    issues.push({
      key: "SESSION_SECRET",
      message: "must be at least 32 characters",
    });
  }

  const tokenKey = env.TOKEN_ENCRYPTION_KEY ?? "";
  if (tokenKey.length === 0) {
    issues.push({ key: "TOKEN_ENCRYPTION_KEY", message: "required" });
  } else {
    const bytes = decodeCanonicalKey(tokenKey);
    if (!bytes) {
      issues.push({
        key: "TOKEN_ENCRYPTION_KEY",
        message: "must be canonical standard base64 (no whitespace; round-trip)",
      });
    } else if (bytes.length !== 32) {
      issues.push({
        key: "TOKEN_ENCRYPTION_KEY",
        message: "must decode to exactly 32 bytes",
      });
    }
  }

  const keyVersion = env.TOKEN_ENCRYPTION_KEY_VERSION?.trim() ?? "";
  if (keyVersion.length === 0) {
    issues.push({ key: "TOKEN_ENCRYPTION_KEY_VERSION", message: "required" });
  } else if (!KEY_VERSION_LABEL.test(keyVersion)) {
    issues.push({
      key: "TOKEN_ENCRYPTION_KEY_VERSION",
      message: "must match v<positive-integer> (e.g. v1)",
    });
  }

  const appOrigin = env.APP_ORIGIN?.trim() ?? "";
  if (appOrigin.length === 0) {
    issues.push({
      key: "APP_ORIGIN",
      message: "required for CSRF Origin checks (e.g. http://localhost:3000)",
    });
  } else {
    try {
      const url = new URL(appOrigin);
      if (appOrigin.replace(/\/$/, "") !== url.origin) {
        issues.push({
          key: "APP_ORIGIN",
          message: "must be a bare origin (no path or trailing slash)",
        });
      }
    } catch {
      issues.push({
        key: "APP_ORIGIN",
        message: "must be a valid absolute URL origin",
      });
    }
  }

  const allowlist = env.GITLAB_URL_ALLOWLIST?.trim() ?? "";
  if (allowlist.length === 0) {
    warnings.push({
      key: "GITLAB_URL_ALLOWLIST",
      message:
        "empty — Settings uses the DB instance allowlist (WP4); set this only if tooling needs an env allowlist",
    });
  } else {
    const entries = allowlist
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const raw = entry.startsWith("internal:")
        ? entry.slice("internal:".length)
        : entry;
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          issues.push({
            key: "GITLAB_URL_ALLOWLIST",
            message: "each entry must be an http(s) origin",
          });
          break;
        }
        if (url.pathname !== "/" && url.pathname !== "") {
          issues.push({
            key: "GITLAB_URL_ALLOWLIST",
            message: "each entry must be an origin (no path)",
          });
          break;
        }
      } catch {
        issues.push({
          key: "GITLAB_URL_ALLOWLIST",
          message: "contains an unparseable entry",
        });
        break;
      }
    }
  }

  const membershipTtl = env.MEMBERSHIP_CACHE_TTL_SECONDS?.trim() ?? "";
  if (membershipTtl.length > 0) {
    const parsed = Number(membershipTtl);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      issues.push({
        key: "MEMBERSHIP_CACHE_TTL_SECONDS",
        message: "must be a positive integer when set",
      });
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}

/** Safe summary for logs/tests — keys + messages only, never values. */
export function summarizeEnvIssues(result: EnvCheckResult): string[] {
  return result.issues.map((i) => `${i.key}: ${i.message}`);
}

export function summarizeEnvWarnings(result: EnvCheckResult): string[] {
  return result.warnings.map((i) => `${i.key}: ${i.message}`);
}

/**
 * Prints every issue/warning (keys only) then throws if any issue is present.
 * Intended for process startup — fail closed with a complete list.
 */
export function assertRuntimeEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const result = validateRuntimeEnv(env);
  const warnings = summarizeEnvWarnings(result);
  const issues = summarizeEnvIssues(result);

  if (warnings.length > 0) {
    console.warn("[reviewpulse:preflight] warnings:");
    for (const line of warnings) {
      console.warn(`  - ${line}`);
    }
  }
  if (issues.length > 0) {
    console.error("[reviewpulse:preflight] missing or invalid environment:");
    for (const line of issues) {
      console.error(`  - ${line}`);
    }
    throw new Error(
      `Environment preflight failed (${issues.length} issue(s)). See messages above (keys only; values never logged).`,
    );
  }
}
