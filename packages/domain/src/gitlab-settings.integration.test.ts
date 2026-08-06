/**
 * WP3b + WP4 PostgreSQL integration tests: PAT vault wiring, GitLab identity
 * binding, IDOR scoping, allowlist intersection, and per-user enable.
 *
 * The GitLab side is injected (`GitLabIdentityProbe` / `AllowlistedProjectProbe`)
 * because the WP2 SSRF policy denies loopback for every origin, allowlisted or
 * not — so a live local GitLab is not a legal target. The default seams remain
 * the WP2 read client and are covered by the gitlab-client suite.
 *
 * Requires a migrated database via DATABASE_URL. Locally (no Docker) the suite
 * skips; in CI it must run, so a missing database fails the job loudly.
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
import { GitLabUnauthorizedError } from "@reviewpulse/gitlab-client";

import {
  ConnectionPolicyError,
  GitLabConnectionService,
  type GitLabIdentityProbe,
} from "./gitlab-connection.js";
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
    "GitLab settings integration tests require a migrated PostgreSQL database (DATABASE_URL)",
  );
}

const skip = databaseReachable
  ? false
  : "PostgreSQL not reachable via DATABASE_URL";

function visibleProject(id: string, path: string): VisibleProject {
  return { id: Number(id), pathWithNamespace: path, name: path.split("/")[1] ?? path };
}

describe("WP3b/WP4 GitLab settings (PostgreSQL)", { skip }, () => {
  const prisma: PrismaClient = getPrisma();
  const sealer = new AesGcmSecretSealer(
    createStaticKeyLoader(randomBytes(32).toString("base64"), "v1"),
  );
  const credentials = createPatCredentialProvider({ prisma, sealer });

  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `inst_${suiteId}`;
  const baseUrl = `https://gitlab-${suiteId}.settings.test`;
  const fixtureUserIds = new Set<string>();

  /** Identity returned for the next probe call, keyed by PAT. */
  const identities = new Map<string, { id: string; username: string }>();
  const probeFailures = new Map<string, Error>();

  const probe: GitLabIdentityProbe = async (input) => {
    const failure = probeFailures.get(input.pat);
    if (failure) {
      throw failure;
    }
    const identity = identities.get(input.pat);
    if (!identity) {
      throw new GitLabUnauthorizedError({ reason: "stub_unknown_pat" });
    }
    return {
      gitlabUserId: identity.id,
      gitlabUsername: identity.username,
      email: null,
      name: identity.username,
    };
  };

  /** Visible projects per PAT; a stored Error means "GitLab is unreachable". */
  const visibility = new Map<string, Map<string, VisibleProject>>();
  const visibilityFailures = new Map<string, Error>();

  const probedProjectIds: string[] = [];

  const probeAllowlisted: AllowlistedProjectProbe = async (input) => {
    probedProjectIds.push(...input.projectIds);
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

  const connections = new GitLabConnectionService(prisma, credentials, probe);
  const projects = new LiveProjectAccessService(
    prisma,
    credentials,
    probeAllowlisted,
  );

  function fixtureId(): string {
    return randomUUID().replace(/-/g, "");
  }

  async function createUser(): Promise<string> {
    const id = `user_${suiteId}_${fixtureId()}`;
    const address = `${id}@settings.test`;
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

  /** Registers a PAT with the stub GitLab and returns it. */
  function issuePat(gitlabUserId: string, username = `gl-${gitlabUserId}`): string {
    const pat = `glpat-${suiteId}-${fixtureId()}`;
    identities.set(pat, { id: gitlabUserId, username });
    return pat;
  }

  async function allowlistProject(
    gitlabProjectId: string,
    path: string,
  ): Promise<void> {
    await prisma.reviewPulseProjectAllowlist.create({
      data: { gitlabInstanceId: instanceId, gitlabProjectId, pathWithNamespace: path },
    });
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: { id: instanceId, baseUrlNormalized: baseUrl, internal: false },
    });
  });

  afterEach(async () => {
    const ids = [...fixtureUserIds];
    fixtureUserIds.clear();
    identities.clear();
    probeFailures.clear();
    visibility.clear();
    visibilityFailures.clear();
    probedProjectIds.length = 0;

    if (ids.length > 0) {
      await prisma.auditEvent.deleteMany({
        where: { actorUserId: { in: ids } },
      });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.reviewPulseProjectAllowlist.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
  });

  after(async () => {
    await prisma.gitLabInstanceAllowlist.deleteMany({
      where: { id: instanceId },
    });
    await prisma.$disconnect();
  });

  it("seals the PAT and exposes only a last4 hint", async () => {
    const userId = await createUser();
    const pat = issuePat("4001", "ada");

    const saved = await connections.saveConnection({ userId, baseUrl, pat });

    assert.equal(saved.gitlabUserId, "4001");
    assert.equal(saved.gitlabUsername, "ada");
    assert.equal(saved.patHintLast4, pat.slice(-4));

    const credentialRows = await prisma.userCredential.findMany({
      where: { connectionId: saved.id },
    });
    assert.equal(credentialRows.length, 1);
    const row = credentialRows[0];
    assert.ok(row);
    assert.equal(Buffer.from(row.ciphertext).toString("utf8").includes(pat), false);
    assert.equal(JSON.stringify(row).includes(pat), false);
    assert.equal(row.status, "active");

    // The vault can still decrypt it — the plaintext just never lands in a row.
    assert.equal(await credentials.getAccessToken(saved.id), pat);

    const views = await connections.listForUser(userId);
    assert.equal(views.length, 1);
    assert.equal(JSON.stringify(views).includes(pat), false);
    assert.equal(views[0]?.patHintLast4, pat.slice(-4));
  });

  it("refuses a GitLab base URL that is not exact-allowlisted", async () => {
    const userId = await createUser();
    const pat = issuePat("4002");

    await assert.rejects(
      () =>
        connections.saveConnection({
          userId,
          baseUrl: `https://evil-${suiteId}.settings.test`,
          pat,
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /allowlisted/i.test(error.message),
    );
    assert.equal(await prisma.gitLabConnection.count({ where: { userId } }), 0);
  });

  it("refuses a PAT that GitLab rejects and stores nothing", async () => {
    const userId = await createUser();

    await assert.rejects(
      () =>
        connections.saveConnection({
          userId,
          baseUrl,
          pat: `glpat-${suiteId}-unknown`,
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /rejected/i.test(error.message),
    );

    assert.equal(await prisma.gitLabConnection.count({ where: { userId } }), 0);
    assert.equal(
      await prisma.userCredential.count({
        where: { connection: { userId } },
      }),
      0,
    );
  });

  it("refuses to bind one GitLab identity to two ReviewPulse users", async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const sharedGitlabUserId = "4100";

    await connections.saveConnection({
      userId: firstUserId,
      baseUrl,
      pat: issuePat(sharedGitlabUserId, "shared"),
    });

    await assert.rejects(
      () =>
        connections.saveConnection({
          userId: secondUserId,
          baseUrl,
          pat: issuePat(sharedGitlabUserId, "shared"),
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /already linked/i.test(error.message),
    );

    assert.equal(
      await prisma.gitLabConnection.count({
        where: { gitlabInstanceId: instanceId, gitlabUserId: sharedGitlabUserId },
      }),
      1,
    );
    assert.equal(
      await prisma.gitLabConnection.count({ where: { userId: secondUserId } }),
      0,
    );
  });

  it("scopes connection reads and writes to the owning user (IDOR)", async () => {
    const ownerId = await createUser();
    const attackerId = await createUser();
    const owned = await connections.saveConnection({
      userId: ownerId,
      baseUrl,
      pat: issuePat("4200", "owner"),
    });

    assert.deepEqual(await connections.listForUser(attackerId), []);

    for (const attempt of [
      () =>
        connections.deleteConnection({
          userId: attackerId,
          connectionId: owned.id,
        }),
      () =>
        connections.retestStored({
          userId: attackerId,
          connectionId: owned.id,
        }),
    ]) {
      await assert.rejects(
        attempt,
        (error: unknown) =>
          error instanceof ConnectionPolicyError &&
          /not found/i.test(error.message),
      );
    }

    const stillActive = await prisma.gitLabConnection.findUniqueOrThrow({
      where: { id: owned.id },
    });
    assert.equal(stillActive.status, "active");
    assert.equal(
      await prisma.userCredential.count({
        where: { connectionId: owned.id, status: "active" },
      }),
      1,
    );
  });

  it("replaces a PAT by superseding the old credential and clearing cache rows", async () => {
    const userId = await createUser();
    const firstPat = issuePat("4300", "rotator");
    const saved = await connections.saveConnection({
      userId,
      baseUrl,
      pat: firstPat,
    });

    await prisma.membershipCache.create({
      data: {
        userId,
        gitlabInstanceId: instanceId,
        gitlabProjectId: "9001",
        allowed: true,
        checkedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
      },
    });

    const secondPat = issuePat("4300", "rotator");
    const replaced = await connections.saveConnection({
      userId,
      baseUrl,
      pat: secondPat,
    });

    assert.equal(replaced.id, saved.id);
    assert.equal(replaced.patHintLast4, secondPat.slice(-4));
    assert.equal(await credentials.getAccessToken(saved.id), secondPat);
    assert.equal(
      await prisma.userCredential.count({
        where: { connectionId: saved.id, status: "active" },
      }),
      1,
    );
    assert.equal(
      await prisma.userCredential.count({
        where: { connectionId: saved.id, status: "superseded" },
      }),
      1,
    );
    assert.equal(
      await prisma.membershipCache.count({ where: { userId } }),
      0,
      "replacing a PAT must drop cached membership decisions",
    );
  });

  it("deleting a connection revokes the credential and clears cache rows", async () => {
    const userId = await createUser();
    const saved = await connections.saveConnection({
      userId,
      baseUrl,
      pat: issuePat("4400", "leaver"),
    });
    await prisma.membershipCache.create({
      data: {
        userId,
        gitlabInstanceId: instanceId,
        gitlabProjectId: "9002",
        allowed: true,
        checkedAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
      },
    });

    await connections.deleteConnection({ userId, connectionId: saved.id });

    const connection = await prisma.gitLabConnection.findUniqueOrThrow({
      where: { id: saved.id },
    });
    assert.equal(connection.status, "deleted");

    const credential = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId: saved.id },
    });
    assert.equal(credential.status, "revoked");
    assert.equal(credential.invalidationReason, "connection_deleted");
    assert.equal(await prisma.membershipCache.count({ where: { userId } }), 0);
    assert.deepEqual(await connections.listForUser(userId), []);

    // A dead PAT must not take the ReviewPulse account with it.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.status, "active");
  });

  it("marks a revoked PAT invalid without touching the ReviewPulse account", async () => {
    const userId = await createUser();
    const pat = issuePat("4500", "revoked-later");
    const saved = await connections.saveConnection({ userId, baseUrl, pat });

    probeFailures.set(pat, new GitLabUnauthorizedError({ reason: "revoked" }));

    await assert.rejects(() =>
      connections.retestStored({ userId, connectionId: saved.id }),
    );

    const connection = await prisma.gitLabConnection.findUniqueOrThrow({
      where: { id: saved.id },
    });
    assert.equal(connection.status, "invalid");

    const credential = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId: saved.id },
    });
    assert.equal(credential.status, "invalid");
    assert.equal(credential.invalidationReason, "gitlab_unauthorized");

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.status, "active");
    assert.equal(
      await prisma.session.count({ where: { userId, revokedAt: null } }),
      0,
      "no sessions were created in this test, so none may appear",
    );
  });

  it("lists only the intersection of allowlist and GitLab-visible projects", async () => {
    const userId = await createUser();
    const pat = issuePat("4600", "lister");
    await connections.saveConnection({ userId, baseUrl, pat });

    await allowlistProject("101", "group/allowed-and-visible");
    await allowlistProject("102", "group/allowed-not-visible");
    visibility.set(
      pat,
      new Map([
        ["101", visibleProject("101", "group/allowed-and-visible")],
        ["103", visibleProject("103", "group/visible-not-allowlisted")],
      ]),
    );

    const listed = await projects.listForUser(userId);
    const byId = new Map(listed.map((item) => [item.gitlabProjectId, item]));

    assert.deepEqual([...byId.keys()].sort(), ["101", "102"]);
    assert.equal(byId.get("101")?.gitlabVisible, true);
    assert.equal(byId.get("102")?.gitlabVisible, false);
    assert.equal(byId.has("103"), false);
  });

  it("enables only allowlisted projects the caller's PAT can see", async () => {
    const userId = await createUser();
    const pat = issuePat("4700", "enabler");
    await connections.saveConnection({ userId, baseUrl, pat });

    await allowlistProject("201", "group/visible");
    await allowlistProject("202", "group/invisible");
    visibility.set(pat, new Map([["201", visibleProject("201", "group/visible")]]));

    await projects.enable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "201",
    });

    await assert.rejects(
      () =>
        projects.enable({
          userId,
          gitlabInstanceId: instanceId,
          gitlabProjectId: "202",
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /not visible/i.test(error.message),
    );
    await assert.rejects(
      () =>
        projects.enable({
          userId,
          gitlabInstanceId: instanceId,
          gitlabProjectId: "999",
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /allowlist/i.test(error.message),
    );

    const enabled = await prisma.userProjectEnable.findMany({
      where: { userId },
    });
    assert.deepEqual(
      enabled.map((row) => row.gitlabProjectId),
      ["201"],
    );
    assert.deepEqual(await projects.authorizedProjectIds(userId), [
      { gitlabInstanceId: instanceId, gitlabProjectId: "201" },
    ]);
  });

  it("keeps one user's enable out of another user's authorization", async () => {
    const firstUserId = await createUser();
    const secondUserId = await createUser();
    const firstPat = issuePat("4800", "first");
    const secondPat = issuePat("4801", "second");
    await connections.saveConnection({
      userId: firstUserId,
      baseUrl,
      pat: firstPat,
    });
    await connections.saveConnection({
      userId: secondUserId,
      baseUrl,
      pat: secondPat,
    });

    await allowlistProject("301", "group/shared");
    const shared = new Map([["301", visibleProject("301", "group/shared")]]);
    visibility.set(firstPat, shared);
    visibility.set(secondPat, shared);

    await projects.enable({
      userId: firstUserId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "301",
    });

    assert.deepEqual(await projects.authorizedProjectIds(firstUserId), [
      { gitlabInstanceId: instanceId, gitlabProjectId: "301" },
    ]);
    assert.deepEqual(await projects.authorizedProjectIds(secondUserId), []);

    // Disable only removes the caller's own row.
    await projects.disable({
      userId: secondUserId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "301",
    });
    assert.equal(
      await prisma.userProjectEnable.count({ where: { userId: firstUserId } }),
      1,
    );

    await projects.disable({
      userId: firstUserId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "301",
    });
    assert.deepEqual(await projects.authorizedProjectIds(firstUserId), []);
  });

  it("fails closed when GitLab access cannot be verified", async () => {
    const userId = await createUser();
    const pat = issuePat("4900", "flaky");
    await connections.saveConnection({ userId, baseUrl, pat });
    await allowlistProject("401", "group/flaky");
    visibility.set(pat, new Map([["401", visibleProject("401", "group/flaky")]]));

    await projects.enable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "401",
    });

    visibilityFailures.set(pat, new GitLabUnauthorizedError({ reason: "expired" }));
    await prisma.membershipCache.deleteMany({ where: { userId } });

    const listed = await projects.listForUser(userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.gitlabVisible, false);
    assert.equal(listed[0]?.enabled, true);
    assert.match(String(listed[0]?.error), /credential rejected/i);

    assert.deepEqual(
      await projects.authorizedProjectIds(userId),
      [],
      "an unverifiable PAT must not authorize a previously enabled project",
    );

    await assert.rejects(() =>
      projects.enable({
        userId,
        gitlabInstanceId: instanceId,
        gitlabProjectId: "401",
      }),
    );
  });

  it("authorizes nothing for a user without a GitLab connection", async () => {
    const userId = await createUser();
    await allowlistProject("501", "group/no-connection");

    assert.deepEqual(await projects.listForUser(userId), []);
    assert.deepEqual(await projects.authorizedProjectIds(userId), []);
    await assert.rejects(
      () =>
        projects.enable({
          userId,
          gitlabInstanceId: instanceId,
          gitlabProjectId: "501",
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /connection/i.test(error.message),
    );
  });

  it("drops authorization once the connection is deleted", async () => {
    const userId = await createUser();
    const pat = issuePat("5000", "departing");
    const saved = await connections.saveConnection({ userId, baseUrl, pat });
    await allowlistProject("601", "group/departing");
    visibility.set(pat, new Map([["601", visibleProject("601", "group/departing")]]));

    await projects.enable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "601",
    });
    assert.equal((await projects.authorizedProjectIds(userId)).length, 1);

    await connections.deleteConnection({ userId, connectionId: saved.id });

    assert.deepEqual(await projects.authorizedProjectIds(userId), []);
    assert.deepEqual(await projects.listForUser(userId), []);
  });
});
