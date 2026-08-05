import { checkDatabaseConnectivity } from "@reviewpulse/db";

/**
 * WP0 worker stub — sync loop lands in WP6.
 * No GitLab calls, mutations, OAuth, Redis, or AI in M1/WP0.
 */
async function main(): Promise<void> {
  const databaseOk = await checkDatabaseConnectivity();
  console.log(
    JSON.stringify({
      service: "reviewpulse-worker",
      milestone: "M1",
      workPackage: "WP0",
      database: databaseOk ? "ok" : "fail",
      mode: "stub",
    }),
  );

  if (!databaseOk) {
    process.exitCode = 1;
  }
}

void main();
