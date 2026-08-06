/**
 * Node-only preload for Next.js / CLI scripts.
 * Loads the monorepo-root `.env` without pulling dotenv into the Next webpack graph.
 *
 * Usage: node --import ./scripts/preload-env.mjs <next-or-tsx> ...
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, "../../../.env");

if (existsSync(rootEnv)) {
  const require = createRequire(import.meta.url);
  // Resolve dotenv from the monorepo (hoisted or @reviewpulse/db).
  let dotenv;
  try {
    dotenv = require("dotenv");
  } catch {
    dotenv = require(resolve(here, "../../../node_modules/dotenv"));
  }
  // Apply key-by-key so `NODE_ENV` is never taken from the file and the value
  // Node/Next provides is neither overwritten nor deleted.
  for (const [key, value] of Object.entries(
    dotenv.parse(readFileSync(rootEnv)),
  )) {
    if (key === "NODE_ENV" || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

// Quiet marker for local debugging (no secret values).
if (process.env.REVIEWPULSE_DEBUG_ENV === "1") {
  console.error(
    `[preload-env] root .env ${existsSync(rootEnv) ? "loaded" : "missing"}`,
  );
}

// Keep import.meta.url referenced so bundlers treat this as an ESM side-effect module.
void pathToFileURL;
