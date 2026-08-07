/**
 * Shared fail-closed setup for PostgreSQL integration suites.
 *
 * Local tests use the same monorepo `.env` loader as runtime processes. CI
 * variables still win because `loadMonorepoEnv` never overwrites existing env.
 */

import { getPrisma } from "./index.js";
import { loadMonorepoEnv } from "./load-env.js";

type DatabaseProbe = {
  $queryRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<unknown>;
};

export function integrationDatabaseUrlIssue(
  env: Record<string, string | undefined>,
): string | null {
  const value = env.DATABASE_URL?.trim() ?? "";
  if (value.length === 0) {
    return "DATABASE_URL is required";
  }
  if (
    !value.startsWith("postgresql://") &&
    !value.startsWith("postgres://")
  ) {
    return "DATABASE_URL must start with postgresql:// or postgres://";
  }
  return null;
}

export async function requirePostgresIntegrationDatabase(
  suiteLabel: string,
  options: {
    env?: Record<string, string | undefined>;
    prisma?: DatabaseProbe;
  } = {},
): Promise<void> {
  loadMonorepoEnv();
  const env = options.env ?? process.env;
  const issue = integrationDatabaseUrlIssue(env);
  if (issue !== null) {
    throw new Error(`${suiteLabel}: ${issue}`);
  }

  try {
    const prisma = options.prisma ?? getPrisma();
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(
      `${suiteLabel}: PostgreSQL is not reachable or not ready. ` +
        "Start PostgreSQL, run npm run db:migrate:deploy, then retry npm run test.",
    );
  }
}
