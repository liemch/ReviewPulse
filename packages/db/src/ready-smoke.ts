#!/usr/bin/env node
/**
 * CI/local smoke: fails closed if DATABASE_URL is unreachable.
 * Prints only ok/fail — never connection strings or secrets.
 */
import { checkDatabaseConnectivity } from "./index.js";
import { loadMonorepoEnv } from "./load-env.js";

loadMonorepoEnv();

const ok = await checkDatabaseConnectivity();
if (!ok) {
  console.error(JSON.stringify({ check: "database", status: "fail" }));
  process.exit(1);
}

console.log(JSON.stringify({ check: "database", status: "ok" }));
