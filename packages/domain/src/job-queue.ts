import type { PrismaClient } from "@reviewpulse/db";

import type { JobQueue, SyncJob, SyncJobSpec, SyncJobStatus } from "./types.js";

export const PROJECT_SYNC_JOB_TYPE = "project_sync" as const;
export const MAX_SYNC_JOB_ATTEMPTS = 5;
export const MAX_SAFE_JOB_ERROR_LENGTH = 120;

const JOB_FAILED_MESSAGE = "Job execution failed";
const JOB_BLOCKED_MESSAGE = "Project sync blocked";
const STALE_CLAIM_MESSAGE = "Worker claim expired";

type JobRow = {
  id: string;
  jobType: string;
  gitlabInstanceId: string | null;
  gitlabProjectId: string | null;
  status: SyncJobStatus;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
};

export type PostgresJobQueueOptions = {
  staleClaimSeconds?: number;
};

/**
 * Error details can contain PATs, URLs, response bodies, or user data. Queue
 * rows retain only a bounded generic category suitable for operator UIs.
 */
export function sanitizeJobError(
  _error: string | Error | unknown,
  category: "failed" | "blocked" | "stale" = "failed",
): string {
  const generic =
    category === "blocked"
      ? JOB_BLOCKED_MESSAGE
      : category === "stale"
        ? STALE_CLAIM_MESSAGE
        : JOB_FAILED_MESSAGE;
  return generic.slice(0, MAX_SAFE_JOB_ERROR_LENGTH);
}

function toSyncJob(row: JobRow): SyncJob {
  if (
    row.jobType !== PROJECT_SYNC_JOB_TYPE ||
    row.gitlabInstanceId === null ||
    row.gitlabProjectId === null
  ) {
    throw new Error("Claimed queue row is not a valid project_sync job");
  }
  return {
    id: row.id,
    jobType: PROJECT_SYNC_JOB_TYPE,
    gitlabInstanceId: row.gitlabInstanceId,
    gitlabProjectId: row.gitlabProjectId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    runAfter: row.runAfter,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
  };
}

export function projectSyncAdvisoryLockKey(
  spec: Pick<SyncJobSpec, "gitlabInstanceId" | "gitlabProjectId">,
): string {
  return JSON.stringify([
    PROJECT_SYNC_JOB_TYPE,
    spec.gitlabInstanceId,
    spec.gitlabProjectId,
  ]);
}

export class PostgresJobQueue implements JobQueue {
  private readonly staleClaimSeconds: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: PostgresJobQueueOptions = {},
  ) {
    this.staleClaimSeconds = options.staleClaimSeconds ?? 300;
    if (!Number.isSafeInteger(this.staleClaimSeconds) || this.staleClaimSeconds <= 0) {
      throw new Error("staleClaimSeconds must be a positive integer");
    }
  }

  /**
   * Coalescing is protected by a transaction-scoped advisory lock because the
   * existing schema intentionally has no partial unique index for active jobs.
   */
  async enqueue(job: SyncJobSpec): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lockKey = projectSyncAdvisoryLockKey(job);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const active = await tx.syncJob.findFirst({
        where: {
          jobType: PROJECT_SYNC_JOB_TYPE,
          gitlabInstanceId: job.gitlabInstanceId,
          gitlabProjectId: job.gitlabProjectId,
          status: { in: ["pending", "running"] },
        },
        select: { id: true },
      });
      if (active) {
        return;
      }
      await tx.syncJob.create({
        data: {
          jobType: PROJECT_SYNC_JOB_TYPE,
          gitlabInstanceId: job.gitlabInstanceId,
          gitlabProjectId: job.gitlabProjectId,
          ...(job.runAfter === undefined ? {} : { runAfter: job.runAfter }),
        },
      });
    });
  }

  async claim(workerId: string): Promise<SyncJob | null> {
    if (workerId.trim().length === 0) {
      throw new Error("workerId is required");
    }
    const rows = await this.prisma.$transaction((tx) =>
      tx.$queryRaw<JobRow[]>`
        WITH candidate AS (
          SELECT id
          FROM sync_jobs
          WHERE status = 'pending'
            AND job_type = ${PROJECT_SYNC_JOB_TYPE}
            AND attempts < ${MAX_SYNC_JOB_ATTEMPTS}
            AND run_after <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          ORDER BY run_after ASC, created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE sync_jobs AS job
        SET status = 'running',
            attempts = job.attempts + 1,
            claimed_by = ${workerId},
            claimed_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            last_error = NULL,
            updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id,
                  job.job_type AS "jobType",
                  job.gitlab_instance_id AS "gitlabInstanceId",
                  job.gitlab_project_id AS "gitlabProjectId",
                  job.status,
                  job.attempts,
                  job.last_error AS "lastError",
                  job.run_after AS "runAfter",
                  job.claimed_by AS "claimedBy",
                  job.claimed_at AS "claimedAt"
      `,
    );
    const row = rows[0];
    return row === undefined ? null : toSyncJob(row);
  }

  async complete(id: string, workerId: string): Promise<boolean> {
    const result = await this.prisma.syncJob.updateMany({
      where: { id, status: "running", claimedBy: workerId },
      data: {
        status: "completed",
        claimedBy: null,
        claimedAt: null,
        lastError: null,
      },
    });
    return result.count > 0;
  }

  async fail(
    id: string,
    workerId: string,
    err: string,
    retryAt?: Date,
  ): Promise<boolean> {
    const safeError = sanitizeJobError(err);
    const retryRequested = retryAt !== undefined;
    const effectiveRetryAt = retryAt ?? new Date();
    const changed = await this.prisma.$executeRaw`
      UPDATE sync_jobs
      SET status = CASE
            WHEN ${retryRequested} AND attempts < ${MAX_SYNC_JOB_ATTEMPTS}
              THEN 'pending'::"SyncJobStatus"
            ELSE 'failed'::"SyncJobStatus"
          END,
          run_after = CASE
            WHEN ${retryRequested} AND attempts < ${MAX_SYNC_JOB_ATTEMPTS}
              THEN ${effectiveRetryAt}
            ELSE run_after
          END,
          last_error = ${safeError},
          claimed_by = NULL,
          claimed_at = NULL,
          updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE id = ${id}
        AND status = 'running'
        AND claimed_by = ${workerId}
    `;
    return changed > 0;
  }

  /** Budget continuations are not failures, so undo the claim attempt. */
  async reschedule(
    id: string,
    workerId: string,
    runAfter = new Date(),
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE sync_jobs
      SET status = 'pending',
          attempts = GREATEST(attempts - 1, 0),
          run_after = ${runAfter},
          claimed_by = NULL,
          claimed_at = NULL,
          last_error = NULL,
          updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE id = ${id}
        AND status = 'running'
        AND claimed_by = ${workerId}
    `;
    return changed > 0;
  }

  async syncBlocked(
    id: string,
    workerId: string,
    err?: string,
  ): Promise<boolean> {
    const safeError = sanitizeJobError(err, "blocked");
    const result = await this.prisma.syncJob.updateMany({
      where: { id, status: "running", claimedBy: workerId },
      data: {
        status: "sync_blocked",
        claimedBy: null,
        claimedAt: null,
        lastError: safeError,
      },
    });
    return result.count > 0;
  }

  async heartbeat(
    id: string,
    workerId: string,
    now = new Date(),
  ): Promise<boolean> {
    const result = await this.prisma.syncJob.updateMany({
      where: { id, status: "running", claimedBy: workerId },
      data: { claimedAt: now },
    });
    return result.count > 0;
  }

  async recoverStaleClaims(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - this.staleClaimSeconds * 1_000);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE sync_jobs
      SET status = CASE
            WHEN attempts < ${MAX_SYNC_JOB_ATTEMPTS}
              THEN 'pending'::"SyncJobStatus"
            ELSE 'failed'::"SyncJobStatus"
          END,
          run_after = CASE
            WHEN attempts < ${MAX_SYNC_JOB_ATTEMPTS} THEN ${now}
            ELSE run_after
          END,
          claimed_by = NULL,
          claimed_at = NULL,
          last_error = ${STALE_CLAIM_MESSAGE},
          updated_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE job_type = ${PROJECT_SYNC_JOB_TYPE}
        AND status = 'running'
        AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
      RETURNING id
    `;
    return rows.length;
  }
}

export const PrismaJobQueue = PostgresJobQueue;
