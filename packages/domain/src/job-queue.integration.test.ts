/**
 * Requires a migrated PostgreSQL database. The shared setup loads the root
 * environment and fails closed when PostgreSQL is unavailable.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import {
  MAX_SAFE_JOB_ERROR_LENGTH,
  PostgresJobQueue,
  sanitizeJobError,
} from "./job-queue.js";
import type { SyncJob } from "./types.js";

await requirePostgresIntegrationDatabase("WP6 job queue integration tests");

describe("PostgresJobQueue", () => {
  const prisma: PrismaClient = getPrisma();
  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `wp6_queue_${suiteId}`;
  const PARK_WORKER = `park_${suiteId}`;
  const queue = new PostgresJobQueue(prisma, { staleClaimSeconds: 10 });
  let sequence = 0;

  function projectId(): string {
    sequence += 1;
    return `project_${sequence}`;
  }

  async function enqueue(gitlabProjectId: string, runAfter?: Date): Promise<void> {
    await queue.enqueue({
      jobType: "project_sync",
      gitlabInstanceId: instanceId,
      gitlabProjectId,
      ...(runAfter === undefined ? {} : { runAfter }),
    });
  }

  /**
   * Production `claim()` deliberately takes any due job, so on a database that
   * also holds real rows this suite would be handed a foreign job. Foreign
   * rows are pushed past the suite's horizon instead; `reschedule` gives back
   * the attempt the claim consumed, so nothing outside the suite is damaged.
   */
  async function claimSuiteJob(workerId: string): Promise<SyncJob | null> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const job = await queue.claim(workerId);
      if (job === null) {
        return null;
      }
      if (job.gitlabInstanceId === instanceId) {
        return job;
      }
      await queue.reschedule(job.id, workerId, new Date(Date.now() + 60_000));
    }
    throw new Error("claim kept returning jobs owned by another instance");
  }

  beforeEach(async () => {
    const leaked = await claimSuiteJob(PARK_WORKER);
    assert.equal(leaked, null, "a previous test leaked a claimable job");
  });

  afterEach(async () => {
    await prisma.syncJob.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("coalesces concurrent enqueues for one project", async () => {
    const project = projectId();
    await Promise.all(Array.from({ length: 8 }, () => enqueue(project)));

    assert.equal(
      await prisma.syncJob.count({
        where: {
          gitlabInstanceId: instanceId,
          gitlabProjectId: project,
          status: { in: ["pending", "running"] },
        },
      }),
      1,
    );
  });

  it("claims due jobs once and increments attempts atomically", async () => {
    const first = projectId();
    const second = projectId();
    await Promise.all([enqueue(first), enqueue(second)]);

    const claims = await Promise.all([
      queue.claim("worker-a"),
      queue.claim("worker-b"),
      queue.claim("worker-c"),
    ]);
    const claimed = claims.filter((job): job is SyncJob => job !== null);

    assert.ok(claimed.every((job) => job.gitlabInstanceId === instanceId));
    assert.equal(claimed.length, 2);
    assert.equal(new Set(claimed.map((job) => job.id)).size, 2);
    assert.ok(claimed.every((job) => job.status === "running"));
    assert.ok(claimed.every((job) => job.attempts === 1));
  });

  it("does not claim a future job and completes a running job", async () => {
    const project = projectId();
    await enqueue(project, new Date(Date.now() + 60_000));
    assert.equal(await queue.claim("worker-a"), null);

    await prisma.syncJob.updateMany({
      where: { gitlabInstanceId: instanceId, gitlabProjectId: project },
      data: { runAfter: new Date(Date.now() - 1_000) },
    });
    const claimed = await queue.claim("worker-a");
    assert.ok(claimed);
    const heartbeatAt = new Date("2026-08-07T12:00:00.000Z");
    await queue.heartbeat(claimed.id, "worker-a", heartbeatAt);
    assert.equal(
      (
        await prisma.syncJob.findUniqueOrThrow({ where: { id: claimed.id } })
      ).claimedAt?.getTime(),
      heartbeatAt.getTime(),
    );
    await queue.complete(claimed.id, "worker-a");

    const row = await prisma.syncJob.findUniqueOrThrow({
      where: { id: claimed.id },
    });
    assert.equal(row.status, "completed");
    assert.equal(row.claimedBy, null);
    assert.equal(row.claimedAt, null);
  });

  it("retries only when retryAt is provided and attempts remain", async () => {
    const project = projectId();
    await enqueue(project);
    const claimed = await queue.claim("worker-a");
    assert.ok(claimed);
    const retryAt = new Date(Date.now() + 30_000);
    await queue.fail(
      claimed.id,
      "worker-a",
      "secret token glpat-do-not-store",
      retryAt,
    );

    const retried = await prisma.syncJob.findUniqueOrThrow({
      where: { id: claimed.id },
    });
    assert.equal(retried.status, "pending");
    assert.equal(retried.runAfter.getTime(), retryAt.getTime());
    assert.equal(retried.lastError, "Job execution failed");
    assert.equal(retried.lastError?.includes("glpat"), false);

    await prisma.syncJob.update({
      where: { id: claimed.id },
      data: { runAfter: new Date(Date.now() - 1_000), attempts: 4 },
    });
    const finalClaim = await queue.claim("worker-b");
    assert.ok(finalClaim);
    assert.equal(finalClaim.attempts, 5);
    await queue.fail(finalClaim.id, "worker-b", "still secret", new Date());
    assert.equal(
      (
        await prisma.syncJob.findUniqueOrThrow({ where: { id: finalClaim.id } })
      ).status,
      "failed",
    );
  });

  it("fails immediately without retryAt and supports sync_blocked", async () => {
    const failedProject = projectId();
    await enqueue(failedProject);
    const failed = await queue.claim("worker-a");
    assert.ok(failed);
    await queue.fail(failed.id, "worker-a", "raw upstream response");

    const blockedProject = projectId();
    await enqueue(blockedProject);
    const blocked = await queue.claim("worker-a");
    assert.ok(blocked);
    await queue.syncBlocked(
      blocked.id,
      "worker-a",
      "private credential detail",
    );

    const rows = await prisma.syncJob.findMany({
      where: { id: { in: [failed.id, blocked.id] } },
      orderBy: { status: "asc" },
    });
    assert.deepEqual(
      rows.map((row) => row.status).sort(),
      ["failed", "sync_blocked"],
    );
    assert.ok(rows.every((row) => !row.lastError?.includes("private")));
  });

  it("reschedules a budget continuation without consuming an attempt", async () => {
    const project = projectId();
    await enqueue(project);
    const claimed = await queue.claim("worker-a");
    assert.ok(claimed);
    const runAfter = new Date(Date.now() + 1_000);

    await queue.reschedule(claimed.id, "worker-a", runAfter);

    const row = await prisma.syncJob.findUniqueOrThrow({
      where: { id: claimed.id },
    });
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.runAfter.getTime(), runAfter.getTime());
    assert.equal(row.claimedAt, null);
  });

  it("recovers stale claims and exhausts stale jobs at the attempt limit", async () => {
    const retryProject = projectId();
    const exhaustedProject = projectId();
    const oldClaim = new Date(Date.now() - 60_000);
    await prisma.syncJob.createMany({
      data: [
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: retryProject,
          status: "running",
          attempts: 2,
          claimedBy: "dead-worker",
          claimedAt: oldClaim,
        },
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: exhaustedProject,
          status: "running",
          attempts: 5,
          claimedBy: "dead-worker",
          claimedAt: oldClaim,
        },
      ],
    });

    // Stale recovery is table-wide, so only the suite's own rows can be counted.
    assert.ok((await queue.recoverStaleClaims()) >= 2);
    const reclaimed = await claimSuiteJob("replacement-worker");
    assert.ok(reclaimed);
    assert.equal(reclaimed.gitlabProjectId, retryProject);
    assert.equal(await queue.complete(reclaimed.id, "dead-worker"), false);
    assert.equal(
      (
        await prisma.syncJob.findUniqueOrThrow({ where: { id: reclaimed.id } })
      ).status,
      "running",
      "a stale worker must not complete a replacement worker's claim",
    );
    assert.equal(
      await queue.complete(reclaimed.id, "replacement-worker"),
      true,
    );
    const rows = await prisma.syncJob.findMany({
      where: { gitlabInstanceId: instanceId },
      orderBy: { gitlabProjectId: "asc" },
    });
    assert.equal(
      rows.find((row) => row.gitlabProjectId === retryProject)?.status,
      "completed",
    );
    assert.equal(
      rows.find((row) => row.gitlabProjectId === exhaustedProject)?.status,
      "failed",
    );
    assert.ok(rows.every((row) => row.claimedAt === null));
    assert.equal(
      rows.find((row) => row.gitlabProjectId === exhaustedProject)?.lastError,
      "Worker claim expired",
    );
  });

  it("sanitizes arbitrary errors to bounded generic text", () => {
    const sanitized = sanitizeJobError("glpat-secret\nstack trace");
    assert.equal(sanitized, "Job execution failed");
    assert.ok(sanitized.length <= MAX_SAFE_JOB_ERROR_LENGTH);
  });
});
