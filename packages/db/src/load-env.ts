/**
 * Load the monorepo-root `.env` into `process.env` without overriding values
 * already present in the environment (CI / shell exports win).
 *
 * Never logs secret values. Safe to call multiple times.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseDotenv } from "dotenv";

const LOADED = Symbol.for("reviewpulse.monorepoEnvLoaded");

/** `NODE_ENV` is owned by Node/Next and is never taken from the dotenv file. */
const IGNORED_KEY = "NODE_ENV";

type GlobalWithFlag = typeof globalThis & {
  [LOADED]?: boolean;
};

function isMonorepoRoot(dir: string): boolean {
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "apps"));
}

/**
 * Walk upward from `start` (or this package) until we find the ReviewPulse
 * monorepo root (`apps/` + root `package.json`).
 */
export function findMonorepoRoot(start?: string): string {
  let dir = resolve(start ?? dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 10; i += 1) {
    if (isMonorepoRoot(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Fallbacks when called from apps/web or apps/worker cwd.
  const cwd = process.cwd();
  if (isMonorepoRoot(cwd)) {
    return cwd;
  }
  const parent = resolve(cwd, "../..");
  if (isMonorepoRoot(parent)) {
    return parent;
  }
  throw new Error("Could not locate ReviewPulse monorepo root for .env loading");
}

/**
 * Loads `<monorepo>/.env` into `process.env` if the file exists.
 * Does not create defaults and does not override existing keys.
 * `NODE_ENV` from `.env` is never applied — Next.js / npm scripts own it, and
 * this loader must never write or delete `process.env.NODE_ENV`.
 */
export function loadMonorepoEnv(options?: {
  /** When true, load even if already loaded in this process. */
  force?: boolean;
}): string | null {
  const g = globalThis as GlobalWithFlag;
  if (g[LOADED] && !options?.force) {
    return null;
  }

  const root = findMonorepoRoot();
  const envPath = join(root, ".env");
  const exists = existsSync(envPath);
  if (exists) {
    const env = process.env as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(
      parseDotenv(readFileSync(envPath)),
    )) {
      if (key === IGNORED_KEY || env[key] !== undefined) {
        continue;
      }
      env[key] = value;
    }
  }
  g[LOADED] = true;
  return exists ? envPath : null;
}
