/**
 * WP5 membership cache — PostgreSQL integration tests.
 *
 * GitLab is stubbed via AllowlistedProjectProbe; cache uses real DB rows.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import {
  AesGcmSecretSealer,
  createStaticKeyLoader,
} from "@reviewpulse/crypto";
import { createPatCredentialProvider } from "@reviewpulse/credentials";
import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import {
  GitLabUnauthorizedError,
  GitLabUpstreamUnavailableError,
} from "@reviewpulse/gitlab-client";

import { AllowlistAdminService } from "./allowlist-admin.js";
import { GitLabConnectionService } from "./gitlab-connection.js";
import { MembershipCacheStore } from "./membership-cache.js";
import {
  LiveProjectAccessService,
  type AllowlistedProjectProbe,
  type VisibleProject,
} from "./project-access.js";

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
    "Membership cache integration tests require PostgreSQL (DATABASE_URL)",
  );
}

const skip = databaseReachable
  ? false
  : "PostgreSQL not reachable via DATABASE_URL";

function visibleProject(id: string, path: string): VisibleProject {
  return {
    id: Number(id),
    pathWithNamespace: path,
    name: path.split("/").at(-1) ?? path,
  };
}

describe("WP5 membership cache (PostgreSQL)", { skip }, () => {
  const prisma: PrismaClient = getPrisma();
  const sealer = new AesGcmSecretSealer(
    createStaticKeyLoader(randomBytes(32).toString("base64"), "v1"),
  );
  const credentials = createPatCredentialProvider({ prisma, sealer });
  const cache = new MembershipCacheStore(prisma, 300);

  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `inst_${suiteId}`;
  const baseUrl = `https://gitlab-${suiteId}.cache.test`;
  const fixtureUserIds = new Set<string>();

  const visibility = new Map<string, Map<string, VisibleProject>>();
  const visibilityFailures = new Map<string, Error>();
  let probeCallCount = 0;

  const probeAllowlisted: AllowlistedProjectProbe = async (input) => {
    probeCallCount += input.projectIds.length;
    const failure = visibilityFailures.get(input.pat);
    if (failure) {
      throw failure;
    }
    const all = visibility.get(input.pat) ?? new Map();
    const out = new Map<string, VisibleProject>();
    for (const id of input.projectIds) {
      const ref = all.get(id);
      if (ref) {
        out.set(id, ref);
      }
    }
    return out;
  };

  const projects = new LiveProjectAccessService(
    prisma,
    credentials,
    probeAllowlisted,
    cache,
  );

  function fixtureId(): string {
    return randomUUID().replace(/-/g, "");
  }

  async function createUser(): Promise<string> {
    const id = `user_${suiteId}_${fixtureId()}`;
    const address = `${id}@cache.test`;
    await prisma.user.create({
      data: {
        id,
        email: address,
        normalizedEmail: address,
        passwordHashArgon2id: "not-a-real-hash",
        role: "developer",
      },
    });
    fixtureUserIds.add(id);
    return id;
  }

  function issuePat(gitlabUserId: string): string {
    const pat = `glpat-${suiteId}-${fixtureId()}`;
    visibility.set(pat, new Map());
    return pat;
  }

  async function saveConnection(userId: string, pat: string): Promise<string> {
    const connections = new GitLabConnectionService(
      prisma,
      credentials,
      async () => ({
        gitlabUserId: `gl-${fixtureId()}`,
        gitlabUsername: "cache-user",
        email: null,
        name: null,
      }),
    );
    const saved = await connections.saveConnection({ userId, baseUrl, pat });
    return saved.id;
  }

  async function allowlistProject(projectId: string, path: string): Promise<void> {
    await prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: projectId,
        pathWithNamespace: path,
      },
    });
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: { id: instanceId, baseUrlNormalized: baseUrl, internal: false },
    });
  });

  afterEach(async () => {
    probeCallCount = 0;
    visibility.clear();
    visibilityFailures.clear();
    const ids = [...fixtureUserIds];
    fixtureUserIds.clear();
    if (ids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.reviewPulseProjectAllowlist.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
  });

  after(async () => {
    await prisma.gitLabInstanceAllowlist.deleteMany({ where: { id: instanceId } });
    await prisma.$disconnect();
  });

  it("uses a fresh allowed cache hit without calling GitLab", async () => {
    const userId = await createUser();
    const pat = issuePat("9100");
    visibility.set(
      pat,
      new Map([["501", visibleProject("501", "group/cached-allowed")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("501", "group/cached-allowed");

    probeCallCount = 0;
    await projects.listForUser(userId);
    assert.equal(probeCallCount, 1);

    probeCallCount = 0;
    const listed = await projects.listForUser(userId);
    assert.equal(probeCallCount, 0);
    assert.equal(listed[0]?.gitlabVisible, true);
  });

  it("uses a fresh denied cache hit without calling GitLab", async () => {
    const userId = await createUser();
    const pat = issuePat("9101");
    visibility.set(pat, new Map());
    await saveConnection(userId, pat);
    await allowlistProject("502", "group/cached-denied");

    await projects.listForUser(userId);
    probeCallCount = 0;
    const listed = await projects.listForUser(userId);
    assert.equal(probeCallCount, 0);
    assert.equal(listed[0]?.gitlabVisible, false);
  });

  it("writes cache on missing entry after live probe", async () => {
    const userId = await createUser();
    const pat = issuePat("9102");
    visibility.set(
      pat,
      new Map([["503", visibleProject("503", "group/write-cache")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("503", "group/write-cache");

    await projects.listForUser(userId);
    const row = await prisma.membershipCache.findUnique({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId,
          gitlabInstanceId: instanceId,
          gitlabProjectId: "503",
        },
      },
    });
    assert.ok(row);
    assert.equal(row.allowed, true);
    assert.equal(JSON.stringify(row).includes(pat), false);
  });

  it("re-probes when allowed cache is expired instead of reusing stale allow", async () => {
    const userId = await createUser();
    const pat = issuePat("9103");
    visibility.set(
      pat,
      new Map([["504", visibleProject("504", "group/expired")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("504", "group/expired");

    const now = new Date();
    await prisma.membershipCache.create({
      data: {
        userId,
        gitlabInstanceId: instanceId,
        gitlabProjectId: "504",
        allowed: true,
        checkedAt: new Date(now.getTime() - 600_000),
        expiresAt: new Date(now.getTime() - 1_000),
      },
    });

    probeCallCount = 0;
    const listed = await projects.listForUser(userId);
    assert.equal(probeCallCount, 1);
    assert.equal(listed[0]?.gitlabVisible, true);
  });

  it("treats expiresAt equal to now as expired", async () => {
    const userId = await createUser();
    const pat = issuePat("9104");
    visibility.set(
      pat,
      new Map([["505", visibleProject("505", "group/boundary")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("505", "group/boundary");

    const now = new Date();
    await prisma.membershipCache.create({
      data: {
        userId,
        gitlabInstanceId: instanceId,
        gitlabProjectId: "505",
        allowed: true,
        checkedAt: now,
        expiresAt: now,
      },
    });

    probeCallCount = 0;
    await projects.listForUser(userId);
    assert.equal(probeCallCount, 1);
  });

  it("invalidates credential and cache on GitLab 401 but leaves the user active", async () => {
    const userId = await createUser();
    const pat = issuePat("9105");
    visibility.set(
      pat,
      new Map([["506", visibleProject("506", "group/unauth")]]),
    );
    const connectionId = await saveConnection(userId, pat);
    await allowlistProject("506", "group/unauth");
    await projects.listForUser(userId);

    await prisma.membershipCache.deleteMany({ where: { userId } });
    visibilityFailures.set(pat, new GitLabUnauthorizedError({ status: 401 }));

    const listed = await projects.listForUser(userId);
    assert.match(String(listed[0]?.error), /credential rejected/i);
    assert.equal(
      await prisma.membershipCache.count({ where: { userId } }),
      0,
    );
    const credential = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId },
    });
    assert.equal(credential.status, "invalid");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.status, "active");
  });

  it("denies only project A on 403/404 while project B still works", async () => {
    const userId = await createUser();
    const pat = issuePat("9106");
    visibility.set(
      pat,
      new Map([["601", visibleProject("601", "group/ok")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("600", "group/denied");
    await allowlistProject("601", "group/ok");

    const listed = await projects.listForUser(userId);
    const byId = new Map(listed.map((row) => [row.gitlabProjectId, row]));
    assert.equal(byId.get("600")?.gitlabVisible, false);
    assert.equal(byId.get("601")?.gitlabVisible, true);

    const deniedRow = await prisma.membershipCache.findUnique({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId,
          gitlabInstanceId: instanceId,
          gitlabProjectId: "600",
        },
      },
    });
    assert.equal(deniedRow?.allowed, false);
    const allowedRow = await prisma.membershipCache.findUnique({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId,
          gitlabInstanceId: instanceId,
          gitlabProjectId: "601",
        },
      },
    });
    assert.equal(allowedRow?.allowed, true);
  });

  it("fails closed on network/5xx without writing permanent denied cache", async () => {
    const userId = await createUser();
    const pat = issuePat("9107");
    visibilityFailures.set(
      pat,
      new GitLabUpstreamUnavailableError({ status: 503 }),
    );
    await saveConnection(userId, pat);
    await allowlistProject("602", "group/flaky");

    const listed = await projects.listForUser(userId);
    assert.match(String(listed[0]?.error), /unavailable/i);
    assert.equal(
      await prisma.membershipCache.count({
        where: { userId, gitlabProjectId: "602" },
      }),
      0,
    );
  });

  it("scopes cache by user so A cannot reuse B membership", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const patA = issuePat("9108");
    const patB = issuePat("9109");
    visibility.set(
      patA,
      new Map([["603", visibleProject("603", "group/a")]]),
    );
    visibility.set(patB, new Map());
    await saveConnection(userA, patA);
    await saveConnection(userB, patB);
    await allowlistProject("603", "group/shared");

    await projects.listForUser(userA);
    probeCallCount = 0;
    const listedB = await projects.listForUser(userB);
    assert.equal(probeCallCount, 1);
    assert.equal(listedB[0]?.gitlabVisible, false);
  });

  it("upserts concurrently without duplicate cache rows", async () => {
    const userId = await createUser();
    const pat = issuePat("9110");
    visibility.set(
      pat,
      new Map([["604", visibleProject("604", "group/race")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("604", "group/race");

    await Promise.all([
      cache.write(userId, instanceId, "604", true),
      cache.write(userId, instanceId, "604", true),
      cache.write(userId, instanceId, "604", false),
    ]);

    assert.equal(
      await prisma.membershipCache.count({
        where: { userId, gitlabProjectId: "604" },
      }),
      1,
    );
  });

  it("clears membership cache when a project is disabled", async () => {
    const userId = await createUser();
    const pat = issuePat("9111");
    visibility.set(
      pat,
      new Map([["605", visibleProject("605", "group/disable")]]),
    );
    await saveConnection(userId, pat);
    await allowlistProject("605", "group/disable");
    await projects.enable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "605",
    });
    assert.equal(
      await prisma.membershipCache.count({
        where: { userId, gitlabProjectId: "605" },
      }),
      1,
    );

    await projects.disable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "605",
    });
    assert.equal(
      await prisma.membershipCache.count({
        where: { userId, gitlabProjectId: "605" },
      }),
      0,
    );
  });

  it("drops cached membership when admin removes a project from allowlist", async () => {
    const admin = new AllowlistAdminService(prisma);
    const userId = await createUser();
    const pat = issuePat("9112");
    visibility.set(
      pat,
      new Map([["606", visibleProject("606", "group/removed")]]),
    );
    await saveConnection(userId, pat);
    const row = await admin.addProject({
      gitlabInstanceId: instanceId,
      gitlabProjectId: "606",
      pathWithNamespace: "group/removed",
    });
    await projects.listForUser(userId);
    assert.equal(
      await prisma.membershipCache.count({
        where: { gitlabInstanceId: instanceId, gitlabProjectId: "606" },
      }),
      1,
    );

    await admin.removeProject(row.id);
    assert.equal(
      await prisma.membershipCache.count({
        where: { gitlabInstanceId: instanceId, gitlabProjectId: "606" },
      }),
      0,
    );
  });
});
