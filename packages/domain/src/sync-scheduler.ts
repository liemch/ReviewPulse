import type { PrismaClient } from "@reviewpulse/db";

import {
  PROJECT_SYNC_JOB_TYPE,
  projectSyncAdvisoryLockKey,
} from "./job-queue.js";
import type { ProjectRef } from "./types.js";

export type SyncSchedulerOptions = {
  intervalSeconds?: number;
};

export type SyncScheduleResult = {
  targetsDiscovered: number;
  jobsEnqueued: number;
  jobsCoalesced: number;
};

/**
 * Discovers project targets from per-user enables. One project is synchronized
 * once regardless of how many users enabled it.
 */
export class SyncScheduler {
  private readonly intervalSeconds: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: SyncSchedulerOptions = {},
  ) {
    this.intervalSeconds = options.intervalSeconds ?? 60;
    if (!Number.isSafeInteger(this.intervalSeconds) || this.intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be a positive integer");
    }
  }

  async schedule(now = new Date()): Promise<SyncScheduleResult> {
    const [enabledRows, allowlistedProjects] = await Promise.all([
      this.prisma.userProjectEnable.findMany({
        where: { user: { status: "active" } },
        select: {
          gitlabInstanceId: true,
          gitlabProjectId: true,
          user: {
            select: {
              connections: {
                where: { status: "active" },
                select: { gitlabInstanceId: true },
              },
            },
          },
        },
        orderBy: [
          { gitlabInstanceId: "asc" },
          { gitlabProjectId: "asc" },
        ],
      }),
      this.prisma.reviewPulseProjectAllowlist.findMany({
        select: { gitlabInstanceId: true, gitlabProjectId: true },
      }),
    ]);
    const allowlisted = new Set(
      allowlistedProjects.map(
        (project) =>
          `${project.gitlabInstanceId}\u0000${project.gitlabProjectId}`,
      ),
    );
    const targetMap = new Map<string, ProjectRef>();
    for (const row of enabledRows) {
      const key = `${row.gitlabInstanceId}\u0000${row.gitlabProjectId}`;
      const hasActiveConnection = row.user.connections.some(
        (connection) =>
          connection.gitlabInstanceId === row.gitlabInstanceId,
      );
      if (allowlisted.has(key) && hasActiveConnection) {
        targetMap.set(key, {
          gitlabInstanceId: row.gitlabInstanceId,
          gitlabProjectId: row.gitlabProjectId,
        });
      }
    }
    const targets = [...targetMap.values()];

    let jobsEnqueued = 0;
    let jobsCoalesced = 0;
    for (const target of targets) {
      const created = await this.scheduleTarget(target, now);
      if (created) {
        jobsEnqueued += 1;
      } else {
        jobsCoalesced += 1;
      }
    }
    return {
      targetsDiscovered: targets.length,
      jobsEnqueued,
      jobsCoalesced,
    };
  }

  async scheduleProjectSyncs(now = new Date()): Promise<SyncScheduleResult> {
    return this.schedule(now);
  }

  private async scheduleTarget(target: ProjectRef, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const lockKey = projectSyncAdvisoryLockKey(target);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

      const active = await tx.syncJob.findFirst({
        where: {
          jobType: PROJECT_SYNC_JOB_TYPE,
          gitlabInstanceId: target.gitlabInstanceId,
          gitlabProjectId: target.gitlabProjectId,
          status: { in: ["pending", "running"] },
        },
        select: { id: true },
      });
      if (active) {
        return false;
      }

      const latestTerminal = await tx.syncJob.findFirst({
        where: {
          jobType: PROJECT_SYNC_JOB_TYPE,
          gitlabInstanceId: target.gitlabInstanceId,
          gitlabProjectId: target.gitlabProjectId,
          status: { in: ["completed", "failed", "sync_blocked"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: { updatedAt: true },
      });
      const dueFromTerminal =
        latestTerminal === null
          ? now
          : new Date(
              latestTerminal.updatedAt.getTime() + this.intervalSeconds * 1_000,
            );
      const runAfter = dueFromTerminal > now ? dueFromTerminal : now;

      await tx.syncJob.create({
        data: {
          jobType: PROJECT_SYNC_JOB_TYPE,
          gitlabInstanceId: target.gitlabInstanceId,
          gitlabProjectId: target.gitlabProjectId,
          runAfter,
        },
      });
      return true;
    });
  }
}
