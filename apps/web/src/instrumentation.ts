/**
 * Next.js instrumentation — runs once on Node server boot.
 * Root `.env` is loaded by `scripts/preload-env.mjs` (see package.json scripts).
 * This file must not import `@reviewpulse/db/load-env` (dotenv / NODE_ENV writes
 * must stay out of the webpack graph).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { assertRuntimeEnv } = await import("@reviewpulse/db/env");
  assertRuntimeEnv(process.env);
}
