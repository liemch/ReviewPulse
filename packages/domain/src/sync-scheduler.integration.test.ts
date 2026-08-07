/**
 * Real PostgreSQL coverage for target discovery, completion-based cadence, and
 * advisory-lock coalescing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import { SyncScheduler } from "./sync-scheduler.js";

await requirePostgresIntegrationDatabase("WP6 sync scheduler integration tests");

describe("SyncScheduler", () => {
  const prisma: PrismaClient = getPrisma();
  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `wp6_scheduler_${suiteId}`;
  const userIds = new Set<string>();
  let sequence = 0;

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}_${suiteId}_${sequence}`;
  }

  async function createUser(): Promise<string> {
    const id = nextId("user");
    const email = `${id}@scheduler.test`;
    await prisma.user.create({
      data: {
        id,
        email,
        normalizedEmail: email,
        passwordHashArgon2id: "not-a-real-hash",
        role: "developer",
      },
    });
    await prisma.gitLabConnection.create({
      data: {
        userId: id,
        gitlabInstanceId: instanceId,
        gitlabUserId: nextId("gitlab-user"),
        gitlabUsername: id,
        status: "active",
      },
    });
    userIds.add(id);
    return id;
  }

  async function enable(userId: string, gitlabProjectId: string): Promise<void> {
    // Two users may enable the same project concurrently, so the shared
    // allowlist row has to be inserted in one statement. A Prisma upsert reads
    // then writes, which loses the race on (instance, project) and throws P2002.
    await prisma.reviewPulseProjectAllowlist.createMany({
      data: [{ gitlabInstanceId: instanceId, gitlabProjectId }],
      skipDuplicates: true,
    });
    await prisma.userProjectEnable.create({
      data: { userId, gitlabInstanceId: instanceId, gitlabProjectId },
    });
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: {
        id: instanceId,
        baseUrlNormalized: `https://${instanceId}.scheduler.test`,
        internal: false,
      },
    });
  });

  afterEach(async () => {
    await prisma.syncJob.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
    const ids = [...userIds];
    userIds.clear();
    if (ids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  after(async () => {
    await prisma.gitLabInstanceAllowlist.deleteMany({
      where: { id: instanceId },
    });
    await prisma.$disconnect();
  });

  it("discovers distinct enabled projects across users", async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    await Promise.all([
      enable(firstUser, "shared"),
      enable(secondUser, "shared"),
      enable(secondUser, "second"),
    ]);
    const now = new Date("2026-08-07T00:00:00.000Z");

    await new SyncScheduler(prisma).schedule(now);

    const jobs = await prisma.syncJob.findMany({
      where: { gitlabInstanceId: instanceId },
      orderBy: { gitlabProjectId: "asc" },
    });
    assert.deepEqual(
      jobs.map((job) => job.gitlabProjectId),
      ["second", "shared"],
    );
    assert.ok(jobs.every((job) => job.jobType === "project_sync"));
    assert.ok(jobs.every((job) => job.runAfter.getTime() === now.getTime()));
  });

  it("keeps one active job under concurrent scheduler runs", async () => {
    const user = await createUser();
    await enable(user, "concurrent");
    const schedulers = Array.from(
      { length: 8 },
      () => new SyncScheduler(prisma),
    );

    await Promise.all(schedulers.map((scheduler) => scheduler.schedule()));

    assert.equal(
      await prisma.syncJob.count({
        where: {
          gitlabInstanceId: instanceId,
          gitlabProjectId: "concurrent",
          status: { in: ["pending", "running"] },
        },
      }),
      1,
    );
  });

  it("does not schedule an enabled project removed from the allowlist", async () => {
    const user = await createUser();
    await enable(user, "delisted");
    await prisma.reviewPulseProjectAllowlist.deleteMany({
      where: { gitlabInstanceId: instanceId, gitlabProjectId: "delisted" },
    });

    await new SyncScheduler(prisma).schedule();
    assert.equal(
      await prisma.syncJob.count({
        where: {
          gitlabInstanceId: instanceId,
          gitlabProjectId: "delisted",
        },
      }),
      0,
    );
  });

  it("does not schedule a project without an active candidate connection", async () => {
    const user = await createUser();
    await enable(user, "no-candidate");
    await prisma.gitLabConnection.updateMany({
      where: { userId: user, gitlabInstanceId: instanceId },
      data: { status: "invalid" },
    });

    await new SyncScheduler(prisma).schedule();
    assert.equal(
      await prisma.syncJob.count({
        where: {
          gitlabInstanceId: instanceId,
          gitlabProjectId: "no-candidate",
        },
      }),
      0,
    );
  });

  it("coalesces both pending and running jobs", async () => {
    const user = await createUser();
    await Promise.all([enable(user, "pending"), enable(user, "running")]);
    await prisma.syncJob.createMany({
      data: [
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: "pending",
          status: "pending",
        },
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: "running",
          status: "running",
          attempts: 1,
          claimedBy: "worker",
          claimedAt: new Date(),
        },
      ],
    });

    await new SyncScheduler(prisma).schedule();

    assert.equal(
      await prisma.syncJob.count({
        where: { gitlabInstanceId: instanceId },
      }),
      2,
    );
    assert.equal(
      await prisma.syncJob.count({
        where: {
          gitlabInstanceId: instanceId,
          status: { in: ["pending", "running"] },
        },
      }),
      2,
    );
  });

  it("schedules from the latest completion and never before now", async () => {
    const user = await createUser();
    await Promise.all([enable(user, "recent"), enable(user, "overdue")]);
    const now = new Date("2026-08-07T12:00:00.000Z");
    await prisma.syncJob.createMany({
      data: [
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: "recent",
          status: "completed",
          updatedAt: new Date(now.getTime() - 10_000),
        },
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: "overdue",
          status: "completed",
          updatedAt: new Date(now.getTime() - 120_000),
        },
      ],
    });

    await new SyncScheduler(prisma, { intervalSeconds: 60 }).schedule(now);
    const jobs = await prisma.syncJob.findMany({
      where: {
        gitlabInstanceId: instanceId,
        status: "pending",
      },
    });
    const byProject = new Map(
      jobs.map((job) => [job.gitlabProjectId, job.runAfter]),
    );
    assert.equal(
      byProject.get("recent")?.getTime(),
      now.getTime() + 50_000,
    );
    assert.equal(byProject.get("overdue")?.getTime(), now.getTime());
  });

  it("applies cadence after failed and blocked jobs to prevent a job storm", async () => {
    const user = await createUser();
    await enable(user, "history");
    const now = new Date("2026-08-07T12:00:00.000Z");
    await prisma.syncJob.createMany({
      data: [
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: "history",
          status: "failed",
          updatedAt: new Date(now.getTime() - 1_000),
        },
        {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          gitlabProjectId: "history",
          status: "sync_blocked",
          updatedAt: new Date(now.getTime() - 500),
        },
      ],
    });

    await new SyncScheduler(prisma).schedule(now);
    const pending = await prisma.syncJob.findFirstOrThrow({
      where: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "history",
        status: "pending",
      },
    });
    assert.equal(pending.runAfter.getTime(), now.getTime() + 59_500);
  });
});
