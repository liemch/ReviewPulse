/**
 * Exercises the partial unique indexes on `gitlab_connections` against a real
 * PostgreSQL server, rather than asserting on the text of the migration.
 *
 * These are the constraints every test fixture in the repo has to respect, so
 * a regression here explains fixture failures elsewhere.
 *
 * Requires a migrated database via DATABASE_URL. Locally (no Docker) the suite
 * skips; in CI it must run, so a missing database fails the job loudly.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import { getPrisma, type PrismaClient } from "./index.js";

async function probeDatabase(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    return false;
  }
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const databaseReachable = await probeDatabase();

if (!databaseReachable && process.env.CI) {
  throw new Error(
    "Connection invariant tests require a migrated PostgreSQL database (DATABASE_URL)",
  );
}

const skip = databaseReachable
  ? false
  : "PostgreSQL not reachable via DATABASE_URL";

const PARTIAL_UNIQUE_INDEXES = [
  "gitlab_connections_one_active_per_user_instance",
  "gitlab_connections_one_live_identity",
];

/**
 * Prisma maps the driver's SQLSTATE to P2002; the raw pg 23505 is accepted too
 * in case a partial index defined only in SQL bypasses that mapping. The index
 * names are a last resort so a mapping change reports a real assertion rather
 * than a false negative.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === "P2002" || code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  const message = error instanceof Error ? error.message : "";
  return PARTIAL_UNIQUE_INDEXES.some((index) => message.includes(index));
}

describe("gitlab_connections partial unique invariants", { skip }, () => {
  const prisma: PrismaClient = getPrisma();

  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `inst_${suiteId}`;
  const fixtureUserIds = new Set<string>();
  const cleanupFailures: string[] = [];

  async function createUser(): Promise<string> {
    const userId = `user_${suiteId}_${randomUUID().replace(/-/g, "")}`;
    const address = `${userId}@invariants.test`;

    await prisma.user.create({
      data: {
        id: userId,
        email: address,
        normalizedEmail: address,
        passwordHashArgon2id: "not-a-real-hash",
        role: "developer",
      },
    });
    fixtureUserIds.add(userId);
    return userId;
  }

  function connectionData(userId: string, gitlabUserId: string) {
    return {
      userId,
      gitlabInstanceId: instanceId,
      gitlabUserId,
      gitlabUsername: `invariant-${gitlabUserId.slice(0, 8)}`,
    };
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: {
        id: instanceId,
        baseUrlNormalized: `https://gitlab-${suiteId}.invariants.test`,
      },
    });
  });

  afterEach(async () => {
    const userIds = [...fixtureUserIds];
    fixtureUserIds.clear();

    for (const userId of userIds) {
      try {
        await prisma.user.delete({ where: { id: userId } });
      } catch {
        cleanupFailures.push(userId);
      }
    }
  });

  after(async () => {
    try {
      await prisma.gitLabInstanceAllowlist.deleteMany({
        where: { id: instanceId },
      });
    } catch {
      cleanupFailures.push(instanceId);
    }
    await prisma.$disconnect();

    assert.deepEqual(
      cleanupFailures,
      [],
      "fixture cleanup left rows behind for these ids",
    );
  });

  it("lets two different users each hold one active connection on the same instance", async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();

    const first = await prisma.gitLabConnection.create({
      data: { ...connectionData(firstUserId, `gl_${suiteId}_a`), status: "active" },
    });
    const second = await prisma.gitLabConnection.create({
      data: { ...connectionData(secondUserId, `gl_${suiteId}_b`), status: "active" },
    });

    assert.notEqual(first.id, second.id);
    assert.equal(
      await prisma.gitLabConnection.count({
        where: { gitlabInstanceId: instanceId, status: "active" },
      }),
      2,
    );
  });

  it("rejects a second active connection for the same user and instance", async () => {
    const userId = await createUser();

    await prisma.gitLabConnection.create({
      data: { ...connectionData(userId, `gl_${suiteId}_c`), status: "active" },
    });

    try {
      await prisma.gitLabConnection.create({
        data: { ...connectionData(userId, `gl_${suiteId}_d`), status: "active" },
      });
      assert.fail("expected gitlab_connections_one_active_per_user_instance");
    } catch (error) {
      assert.ok(
        isUniqueViolation(error),
        `expected a unique violation, got ${String(error)}`,
      );
    }

    assert.equal(
      await prisma.gitLabConnection.count({ where: { userId, status: "active" } }),
      1,
    );
  });

  it("lets a superseded connection be replaced by a new active one", async () => {
    const userId = await createUser();

    const previous = await prisma.gitLabConnection.create({
      data: { ...connectionData(userId, `gl_${suiteId}_e`), status: "active" },
    });
    await prisma.gitLabConnection.update({
      where: { id: previous.id },
      data: { status: "superseded" },
    });
    await prisma.gitLabConnection.create({
      data: { ...connectionData(userId, `gl_${suiteId}_f`), status: "active" },
    });

    assert.equal(
      await prisma.gitLabConnection.count({ where: { userId, status: "active" } }),
      1,
    );
    assert.equal(await prisma.gitLabConnection.count({ where: { userId } }), 2);
  });

  it("rejects the same GitLab identity on two live connections", async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const sharedGitlabUserId = `gl_${suiteId}_shared`;

    await prisma.gitLabConnection.create({
      data: {
        ...connectionData(firstUserId, sharedGitlabUserId),
        status: "active",
      },
    });

    for (const status of ["active", "invalid"] as const) {
      try {
        await prisma.gitLabConnection.create({
          data: { ...connectionData(secondUserId, sharedGitlabUserId), status },
        });
        assert.fail(
          `expected gitlab_connections_one_live_identity to reject status ${status}`,
        );
      } catch (error) {
        assert.ok(
          isUniqueViolation(error),
          `expected a unique violation for status ${status}, got ${String(error)}`,
        );
      }
    }

    assert.equal(
      await prisma.gitLabConnection.count({
        where: { gitlabInstanceId: instanceId, gitlabUserId: sharedGitlabUserId },
      }),
      1,
    );
  });
});
