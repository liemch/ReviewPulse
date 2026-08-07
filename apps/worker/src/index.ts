import {
  assertRuntimeEnv,
  checkDatabaseConnectivity,
  disconnectDatabase,
} from "@reviewpulse/db";
import { loadMonorepoEnv } from "@reviewpulse/db/load-env";

import { createWorkerRuntime } from "./runtime.js";
import { runWorkerLoop } from "./worker-loop.js";

async function main(): Promise<void> {
  loadMonorepoEnv();
  assertRuntimeEnv(process.env);

  const databaseOk = await checkDatabaseConnectivity();
  console.log(
    JSON.stringify({
      service: "reviewpulse-worker",
      milestone: "M1",
      workPackage: "WP6",
      database: databaseOk ? "ok" : "fail",
      mode: "sync",
    }),
  );

  if (!databaseOk) {
    throw new Error("Worker database readiness check failed");
  }

  const runtime = createWorkerRuntime();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runWorkerLoop(runtime, {
      signal: controller.signal,
      idleDelayMs: 1_000,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await disconnectDatabase();
  }
}

void main().catch(async () => {
  // Errors may wrap upstream response bodies. Keep process logs category-only.
  console.error("[reviewpulse-worker] fatal worker error");
  process.exitCode = 1;
  try {
    await disconnectDatabase();
  } catch {
    // The original failure remains the process outcome.
  }
});
