import {
  MAX_SYNC_JOB_ATTEMPTS,
  type JobQueue,
  type SyncJob,
  type SyncOutcome,
  type SyncScheduleResult,
} from "@reviewpulse/domain";

export const MAX_JOB_ATTEMPTS = MAX_SYNC_JOB_ATTEMPTS;
export const INITIAL_RETRY_DELAY_MS = 30_000;
export const MAX_RETRY_DELAY_MS = 15 * 60_000;

export type WorkerAuditAction =
  | "sync_started"
  | "sync_completed"
  | "sync_blocked"
  | "sync_paused"
  | "sync_retry_scheduled"
  | "sync_failed";

export interface WorkerAudit {
  write(
    action: WorkerAuditAction,
    job: SyncJob,
    metadata?: Record<string, string | number>,
  ): Promise<void>;
}

export interface WorkerScheduler {
  schedule(now?: Date): Promise<SyncScheduleResult>;
}

export type WorkerJobQueue = JobQueue;

export type WorkerIterationDeps = {
  queue: WorkerJobQueue;
  scheduler: WorkerScheduler;
  execute(job: SyncJob, signal: AbortSignal): Promise<SyncOutcome>;
  audit: WorkerAudit;
  workerId: string;
  now?: () => Date;
  heartbeatIntervalMs?: number;
};

export type WorkerIterationResult =
  | { status: "idle" }
  | { status: "completed"; jobId: string }
  | { status: "paused"; jobId: string }
  | { status: "sync_blocked"; jobId: string }
  | { status: "lost_claim"; jobId: string }
  | { status: "retry_scheduled"; jobId: string; retryAt: Date }
  | { status: "failed"; jobId: string };

export function retryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("attempt must be a positive integer");
  }
  return Math.min(
    MAX_RETRY_DELAY_MS,
    INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
  );
}

export async function runWorkerIteration(
  deps: WorkerIterationDeps,
): Promise<WorkerIterationResult> {
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 60_000;
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0
  ) {
    throw new Error("heartbeatIntervalMs must be a positive integer");
  }
  const now = deps.now ?? (() => new Date());
  const iterationNow = now();
  await deps.queue.recoverStaleClaims(iterationNow);
  await deps.scheduler.schedule(iterationNow);

  const job = await deps.queue.claim(deps.workerId);
  if (job === null) {
    return { status: "idle" };
  }

  await safeAudit(deps.audit, "sync_started", job);
  const executionController = new AbortController();
  let leaseLost = false;
  let heartbeatInFlight: Promise<void> | null = null;
  const loseLease = (): void => {
    leaseLost = true;
    executionController.abort();
  };
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight !== null) {
      return;
    }
    heartbeatInFlight = deps.queue
      .heartbeat(job.id, deps.workerId)
      .then((owned) => {
        if (!owned) {
          loseLease();
        }
      })
      .catch(loseLease)
      .finally(() => {
        heartbeatInFlight = null;
      });
  }, heartbeatIntervalMs);
  heartbeat.unref();
  try {
    const outcome = await deps.execute(job, executionController.signal);
    if (heartbeatInFlight !== null) {
      await heartbeatInFlight;
    }
    if (leaseLost) {
      return { status: "lost_claim", jobId: job.id };
    }
    if (outcome.status === "sync_blocked") {
      const changed = await deps.queue.syncBlocked(job.id, deps.workerId);
      if (!changed) {
        return { status: "lost_claim", jobId: job.id };
      }
      await safeAudit(deps.audit, "sync_blocked", job);
      return { status: "sync_blocked", jobId: job.id };
    }
    if (outcome.status === "paused") {
      const changed = await deps.queue.reschedule(
        job.id,
        deps.workerId,
        now(),
      );
      if (!changed) {
        return { status: "lost_claim", jobId: job.id };
      }
      await safeAudit(deps.audit, "sync_paused", job, {
        nextBranch: outcome.nextBranch,
      });
      return { status: "paused", jobId: job.id };
    }

    const changed = await deps.queue.complete(job.id, deps.workerId);
    if (!changed) {
      return { status: "lost_claim", jobId: job.id };
    }
    await safeAudit(deps.audit, "sync_completed", job, {
      commitsUpserted: outcome.commitsUpserted,
      mergeRequestsUpserted: outcome.mergeRequestsUpserted,
    });
    return { status: "completed", jobId: job.id };
  } catch {
    if (leaseLost) {
      return { status: "lost_claim", jobId: job.id };
    }
    if (job.attempts >= MAX_JOB_ATTEMPTS) {
      const changed = await deps.queue.fail(
        job.id,
        deps.workerId,
        "Job execution failed",
      );
      if (!changed) {
        return { status: "lost_claim", jobId: job.id };
      }
      await safeAudit(deps.audit, "sync_failed", job, {
        attempts: job.attempts,
      });
      return { status: "failed", jobId: job.id };
    }
    const retryAt = new Date(now().getTime() + retryDelayMs(job.attempts));
    const changed = await deps.queue.fail(
      job.id,
      deps.workerId,
      "Job execution failed",
      retryAt,
    );
    if (!changed) {
      return { status: "lost_claim", jobId: job.id };
    }
    await safeAudit(deps.audit, "sync_retry_scheduled", job, {
      attempts: job.attempts,
      retryAtEpochMs: retryAt.getTime(),
    });
    return { status: "retry_scheduled", jobId: job.id, retryAt };
  } finally {
    clearInterval(heartbeat);
  }
}

async function safeAudit(
  audit: WorkerAudit,
  action: WorkerAuditAction,
  job: SyncJob,
  metadata?: Record<string, string | number>,
): Promise<void> {
  try {
    await audit.write(action, job, metadata);
  } catch {
    // Audit availability must not strand or misreport a claimed sync job.
  }
}

export type WorkerLoopOptions = {
  signal: AbortSignal;
  idleDelayMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export async function runWorkerLoop(
  deps: WorkerIterationDeps,
  options: WorkerLoopOptions,
): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const sleep = options.sleep ?? abortableSleep;
  while (!options.signal.aborted) {
    const result = await runWorkerIteration(deps);
    if (result.status === "idle") {
      await sleep(idleDelayMs, options.signal);
    }
  }
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
