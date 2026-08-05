import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __reviewpulsePrisma: PrismaClient | undefined;
  var __reviewpulsePgPool: pg.Pool | undefined;
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool =
    globalThis.__reviewpulsePgPool ?? new pg.Pool({ connectionString });

  if (process.env.NODE_ENV !== "production") {
    globalThis.__reviewpulsePgPool = pool;
  }

  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

/** Lazy PrismaClient — constructed on first use so tooling can import types without DATABASE_URL. */
export function getPrisma(): PrismaClient {
  if (!globalThis.__reviewpulsePrisma) {
    globalThis.__reviewpulsePrisma = createPrismaClient();
  }
  return globalThis.__reviewpulsePrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, receiver) as unknown;
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export async function checkDatabaseConnectivity(): Promise<boolean> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { PrismaClient };
export type * from "@prisma/client";
export {
  summarizeEnvIssues,
  validateWp0Env,
  type EnvCheckResult,
  type EnvIssue,
} from "./env.js";
