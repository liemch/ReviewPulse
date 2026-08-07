import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  SyncJob,
  SyncOutcome,
  SyncScheduleResult,
} from "@reviewpulse/domain";

import {
  retryDelayMs,
  runWorkerIteration,
  type WorkerAudit,
  type WorkerJobQueue,
  type WorkerScheduler,
} from "./worker-loop.js";

function job(attempts = 1): SyncJob {
  return {
    id: "job-1",
    jobType: "project_sync",
    gitlabInstanceId: "instance-1",
    gitlabProjectId: "project-1",
    status: "running",
    attempts,
    lastError: null,
    runAfter: new Date(0),
    claimedBy: "worker-1",
    claimedAt: new Date(0),
  };
}

function harness(
  claimed: SyncJob | null,
  outcome: SyncOutcome | Error,
): {
  queue: WorkerJobQueue;
  scheduler: WorkerScheduler;
  audit: WorkerAudit;
  calls: string[];
} {
  const calls: string[] = [];
  const queue: WorkerJobQueue = {
    enqueue: async () => {},
    claim: async () => claimed,
    complete: async () => {
      calls.push("complete");
      return true;
    },
    fail: async (_id, _workerId, _error, retryAt) => {
      calls.push(retryAt === undefined ? "failed" : "retry");
      return true;
    },
    syncBlocked: async () => {
      calls.push("blocked");
      return true;
    },
    heartbeat: async () => {
      calls.push("heartbeat");
      return true;
    },
    recoverStaleClaims: async () => {
      calls.push("recover");
      return 0;
    },
    reschedule: async () => {
      calls.push("reschedule");
      return true;
    },
  };
  const result: SyncScheduleResult = {
    targetsDiscovered: 0,
    jobsEnqueued: 0,
    jobsCoalesced: 0,
  };
  const scheduler: WorkerScheduler = {
    schedule: async () => {
      calls.push("schedule");
      return result;
    },
  };
  const audit: WorkerAudit = {
    write: async (action) => {
      calls.push(action);
    },
  };
  calls.push(outcome instanceof Error ? "throws" : outcome.status);
  return { queue, scheduler, audit, calls };
}

describe("WP6 worker iteration", () => {
  it("backs off exponentially with the locked cap", () => {
    assert.equal(retryDelayMs(1), 30_000);
    assert.equal(retryDelayMs(2), 60_000);
    assert.equal(retryDelayMs(3), 120_000);
    assert.equal(retryDelayMs(4), 240_000);
    assert.equal(retryDelayMs(10), 15 * 60_000);
  });

  it("completes a successful project sync", async () => {
    const outcome: SyncOutcome = {
      status: "completed",
      commitsUpserted: 2,
      mergeRequestsUpserted: 1,
    };
    const h = harness(job(), outcome);
    const result = await runWorkerIteration({
      ...h,
      workerId: "worker-1",
      execute: async () => outcome,
    });
    assert.equal(result.status, "completed");
    assert.ok(h.calls.includes("complete"));
    assert.ok(h.calls.includes("sync_completed"));
  });

  it("marks an authorization-exhausted project sync_blocked", async () => {
    const outcome: SyncOutcome = {
      status: "sync_blocked",
      code: "SYNC_BLOCKED",
      reason: "no_authorized_candidate",
    };
    const h = harness(job(), outcome);
    const result = await runWorkerIteration({
      ...h,
      workerId: "worker-1",
      execute: async () => outcome,
    });
    assert.equal(result.status, "sync_blocked");
    assert.ok(h.calls.includes("blocked"));
  });

  it("does not audit completion after losing claim ownership", async () => {
    const outcome: SyncOutcome = {
      status: "completed",
      commitsUpserted: 1,
      mergeRequestsUpserted: 1,
    };
    const h = harness(job(), outcome);
    h.queue.complete = async () => false;
    const result = await runWorkerIteration({
      ...h,
      workerId: "worker-1",
      execute: async () => outcome,
    });
    assert.equal(result.status, "lost_claim");
    assert.equal(h.calls.includes("sync_completed"), false);
  });

  it("aborts in-flight sync when the heartbeat loses ownership", async () => {
    const h = harness(
      job(),
      new Error("execution should be aborted"),
    );
    h.queue.heartbeat = async () => false;
    const result = await runWorkerIteration({
      ...h,
      workerId: "worker-1",
      heartbeatIntervalMs: 1,
      execute: async (_job, signal) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    assert.equal(result.status, "lost_claim");
    assert.equal(h.calls.includes("retry"), false);
  });

  it("reschedules a budget continuation without consuming a retry", async () => {
    const outcome: SyncOutcome = {
      status: "paused",
      commitsUpserted: 1,
      mergeRequestsUpserted: 0,
      nextBranch: "feature/b",
    };
    const h = harness(job(), outcome);
    const result = await runWorkerIteration({
      ...h,
      workerId: "worker-1",
      execute: async () => outcome,
    });
    assert.equal(result.status, "paused");
    assert.ok(h.calls.includes("reschedule"));
    assert.equal(h.calls.includes("retry"), false);
  });

  it("retries failures before attempt five and then fails terminally", async () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    const retryHarness = harness(job(4), new Error("secret PAT"));
    const retry = await runWorkerIteration({
      ...retryHarness,
      workerId: "worker-1",
      now: () => now,
      execute: async () => {
        throw new Error("secret PAT");
      },
    });
    assert.equal(retry.status, "retry_scheduled");
    assert.equal(
      retry.status === "retry_scheduled"
        ? retry.retryAt.toISOString()
        : "",
      "2026-08-07T00:04:00.000Z",
    );

    const finalHarness = harness(job(5), new Error("secret PAT"));
    const failed = await runWorkerIteration({
      ...finalHarness,
      workerId: "worker-1",
      execute: async () => {
        throw new Error("secret PAT");
      },
    });
    assert.equal(failed.status, "failed");
    assert.ok(finalHarness.calls.includes("failed"));
  });
});
