import { hostname } from "node:os";

import {
  getPrisma,
  parseSyncRuntimeConfig,
  type PrismaClient,
  type SyncRuntimeConfig,
} from "@reviewpulse/db";
import {
  createDefaultCredentialProvider,
  PostgresJobQueue,
  PrismaSyncPersistence,
  SyncOrchestrator,
  SyncScheduler,
  type SyncBudget,
  type SyncJob,
} from "@reviewpulse/domain";

import type {
  WorkerAudit,
  WorkerAuditAction,
  WorkerIterationDeps,
} from "./worker-loop.js";

class ElapsedSyncBudget implements SyncBudget {
  constructor(
    private readonly startedAtMs: number,
    private readonly budgetMs: number,
    private readonly nowMs: () => number = Date.now,
  ) {}

  shouldStopBetweenBranches(): boolean {
    return this.nowMs() - this.startedAtMs >= this.budgetMs;
  }
}

class PrismaWorkerAudit implements WorkerAudit {
  constructor(private readonly prisma: PrismaClient) {}

  async write(
    action: WorkerAuditAction,
    job: SyncJob,
    metadata: Record<string, string | number> = {},
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        action,
        metaJsonSafe: {
          jobId: job.id,
          jobType: job.jobType,
          gitlabInstanceId: job.gitlabInstanceId,
          gitlabProjectId: job.gitlabProjectId,
          attempts: job.attempts,
          ...metadata,
        },
      },
    });
  }
}

export function createWorkerRuntime(options: {
  prisma?: PrismaClient;
  env?: Record<string, string | undefined>;
  workerId?: string;
  nowMs?: () => number;
} = {}): WorkerIterationDeps & { config: SyncRuntimeConfig } {
  const prisma = options.prisma ?? getPrisma();
  const config = parseSyncRuntimeConfig(options.env ?? process.env);
  const credentials = createDefaultCredentialProvider(prisma);
  const queue = new PostgresJobQueue(prisma, {
    staleClaimSeconds: config.syncStaleClaimSeconds,
  });
  const scheduler = new SyncScheduler(prisma, {
    intervalSeconds: config.syncPollIntervalSeconds,
  });
  const persistence = new PrismaSyncPersistence(prisma);
  const nowMs = options.nowMs ?? Date.now;

  return {
    config,
    queue,
    scheduler,
    audit: new PrismaWorkerAudit(prisma),
    workerId:
      options.workerId ?? `${hostname()}:${process.pid}:reviewpulse-worker`,
    execute: async (job, signal) => {
      const startedAtMs = nowMs();
      const budget = new ElapsedSyncBudget(
        startedAtMs,
        config.syncJobBudgetSeconds * 1_000,
        nowMs,
      );
      const orchestrator = new SyncOrchestrator({
        persistence,
        credentials,
        budget,
        signal,
        commitLookbackOverlapMs:
          config.commitLookbackOverlapSeconds * 1_000,
      });
      return orchestrator.syncProject({
        gitlabInstanceId: job.gitlabInstanceId,
        gitlabProjectId: job.gitlabProjectId,
      });
    },
  };
}
