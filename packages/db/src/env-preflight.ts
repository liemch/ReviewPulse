/**
 * CLI: load monorepo `.env` and print a complete preflight report (keys only).
 *
 *   npm run env:preflight
 */

import {
  assertRuntimeEnv,
  summarizeEnvIssues,
  summarizeEnvWarnings,
  validateRuntimeEnv,
} from "./env.js";
import { loadMonorepoEnv } from "./load-env.js";

const loaded = loadMonorepoEnv();
console.log(
  `[reviewpulse:preflight] root .env: ${loaded ? "loaded" : "not found (using process.env only)"}`,
);

const result = validateRuntimeEnv(process.env);
for (const line of summarizeEnvWarnings(result)) {
  console.warn(`warning: ${line}`);
}
for (const line of summarizeEnvIssues(result)) {
  console.error(`error: ${line}`);
}

if (!result.ok) {
  assertRuntimeEnv(process.env);
}

console.log("[reviewpulse:preflight] ok");
