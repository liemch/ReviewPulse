/**
 * WP7/WP8 — Dashboard authz + metric snapshot immutability (PostgreSQL).
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
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import { DashboardQueryService } from "./dashboard-query.js";
import { EmailAliasService } from "./email-alias.js";
import { GitLabConnectionService } from "./gitlab-connection.js";
import { FORBIDDEN_METRIC_KEYS } from "./metrics/types.js";
import {
  LiveProjectAccessService,
  type AllowlistedProjectProbe,
  type VisibleProject,
} from "./project-access.js";

await requirePostgresIntegrationDatabase("Dashboard query integration tests");

function visible(id: string, path: string): VisibleProject {
  return {
    id: Number(id),
    pathWithNamespace: path,
    name: path.split("/").at(-1) ?? path,
  };
}

describe("WP7 dashboard query (PostgreSQL)", () => {
  const prisma: PrismaClient = getPrisma();
  const sealer = new AesGcmSecretSealer(
    createStaticKeyLoader(randomBytes(32).toString("base64"), "v1"),
  );
  const credentials = createPatCredentialProvider({ prisma, sealer });
  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `inst_dash_${suiteId}`;
  const baseUrl = `https://gitlab-dash-${suiteId}.test`;
  const fixtureUserIds = new Set<string>();
  const visibility = new Map<string, Map<string, VisibleProject>>();

  const probe: AllowlistedProjectProbe = async (input) => {
    const all = visibility.get(input.pat) ?? new Map();
    const out = new Map<string, VisibleProject>();
    for (const id of input.projectIds) {
      const ref = all.get(id);
      if (ref) out.set(id, ref);
    }
    return { visible: out, failed: new Map() };
  };

  const projects = new LiveProjectAccessService(
    prisma,
    credentials,
    probe,
  );
  const dashboard = new DashboardQueryService(prisma, projects);
  const emails = new EmailAliasService(prisma);

  async function createUser(suffix: string): Promise<string> {
    const id = `user_${suiteId}_${suffix}`;
    const address = `${id}@dash.test`;
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

  async function connect(userId: string, pat: string): Promise<void> {
    visibility.set(pat, new Map([["701", visible("701", "group/a")]]));
    const connections = new GitLabConnectionService(
      prisma,
      credentials,
      async () => ({
        gitlabUserId: `gl-${randomUUID().slice(0, 8)}`,
        gitlabUsername: "dash-user",
        email: null,
        name: null,
      }),
    );
    await connections.saveConnection({ userId, baseUrl, pat });
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: { id: instanceId, baseUrlNormalized: baseUrl, internal: false },
    });
    await prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "701",
        pathWithNamespace: "group/a",
      },
    });
    await prisma.kpiRuleSet.upsert({
      where: {
        role_version: { role: "DEV", version: "dev-kpi-ref-2026.08.1" },
      },
      create: {
        role: "DEV",
        version: "dev-kpi-ref-2026.08.1",
        effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
        notesJson: {},
        rules: {
          create: [
            {
              metricKey: "commit_frequency",
              referenceMin: 3,
              referenceMax: 8,
              unit: "commits_per_week",
              status: "active",
            },
            {
              metricKey: "ai_assisted_commits",
              unit: "commits",
              detectionRule: "\\[[Aa][Ii]\\]",
              status: "active",
            },
            {
              metricKey: "loc_weekly",
              referenceMin: 500,
              unit: "loc_per_week",
              status: "active",
            },
            {
              metricKey: "mr_size",
              referenceMax: 400,
              unit: "lines_per_mr",
              status: "active",
            },
          ],
        },
      },
      update: {},
    });
  });

  afterEach(async () => {
    const ids = [...fixtureUserIds];
    fixtureUserIds.clear();
    if (ids.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.commitCache.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
    await prisma.mergeRequestCache.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
  });

  after(async () => {
    await prisma.reviewPulseProjectAllowlist.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
    await prisma.gitLabInstanceAllowlist.deleteMany({
      where: { id: instanceId },
    });
    await prisma.$disconnect();
  });

  it("hides warm cache rows after enable is revoked (fail closed)", async () => {
    const userId = await createUser("a");
    const pat = `glpat-dash-${suiteId}-a`;
    await connect(userId, pat);
    await projects.enable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "701",
    });
    await prisma.commitCache.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "701",
        sha: "abc123",
        title: "[AI] secret project commit",
        authorEmail: "a@dash.test",
        authorEmailNormalized: "a@dash.test",
        authoredAt: new Date(),
        webUrl: "https://example.test/c/abc123",
        rawPayloadUpdatedAt: new Date(),
      },
    });

    const before = await dashboard.query(userId);
    assert.equal(before.commits.length, 1);
    assert.ok(before.metrics.every((m) => !("score" in m)));

    await projects.disable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "701",
    });

    const after = await dashboard.query(userId);
    assert.equal(after.authorizedProjects.length, 0);
    assert.equal(after.commits.length, 0);
    assert.equal(
      await prisma.commitCache.count({
        where: { gitlabInstanceId: instanceId, sha: "abc123" },
      }),
      1,
      "cache may remain on disk but must not be returned",
    );
  });

  it("does not leak another user's authorized project commits (IDOR)", async () => {
    const userA = await createUser("idor_a");
    const userB = await createUser("idor_b");
    const patA = `glpat-dash-${suiteId}-idor-a`;
    const patB = `glpat-dash-${suiteId}-idor-b`;
    await connect(userA, patA);
    visibility.set(patB, new Map()); // B cannot see 701
    const connections = new GitLabConnectionService(
      prisma,
      credentials,
      async () => ({
        gitlabUserId: `gl-b-${randomUUID().slice(0, 8)}`,
        gitlabUsername: "dash-b",
        email: null,
        name: null,
      }),
    );
    await connections.saveConnection({
      userId: userB,
      baseUrl,
      pat: patB,
    });

    await projects.enable({
      userId: userA,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "701",
    });
    await prisma.commitCache.create({
      data: {
        gitlabInstanceId: instanceId,
        gitlabProjectId: "701",
        sha: "idorsha",
        title: "only A",
        authorEmail: "a@dash.test",
        authorEmailNormalized: "a@dash.test",
        authoredAt: new Date(),
        webUrl: null,
        rawPayloadUpdatedAt: new Date(),
      },
    });

    const listedB = await dashboard.query(userB);
    assert.equal(listedB.commits.length, 0);
    assert.equal(listedB.authorizedProjects.length, 0);
  });

  it("keeps historical MetricSnapshot rows when rule_version changes", async () => {
    const userId = await createUser("snap");
    const windowStart = new Date("2026-08-03T17:00:00.000Z");
    const windowEnd = new Date("2026-08-10T17:00:00.000Z");
    await prisma.metricSnapshot.create({
      data: {
        userId,
        projectScope: `${instanceId}:701`,
        metricKey: "commit_frequency",
        valueNullable: 4,
        unit: "commits_per_week",
        ruleVersion: "dev-kpi-ref-2026.08.1",
        source: "gitlab",
        calculatedAt: new Date(),
        windowStart,
        windowEnd,
        status: "ok",
      },
    });
    await prisma.metricSnapshot.create({
      data: {
        userId,
        projectScope: `${instanceId}:701`,
        metricKey: "commit_frequency",
        valueNullable: 5,
        unit: "commits_per_week",
        ruleVersion: "dev-kpi-ref-2026.09.1",
        source: "gitlab",
        calculatedAt: new Date(),
        windowStart,
        windowEnd,
        status: "ok",
      },
    });

    const old = await prisma.metricSnapshot.findFirstOrThrow({
      where: { userId, ruleVersion: "dev-kpi-ref-2026.08.1" },
    });
    assert.equal(old.valueNullable, 4);
    assert.equal(
      await prisma.metricSnapshot.count({
        where: { userId, metricKey: "commit_frequency" },
      }),
      2,
    );
  });

  it("email alias add/remove is scoped to the caller", async () => {
    const userId = await createUser("mail");
    const row = await emails.addAlias({
      userId,
      email: "Alias.User@Example.COM",
    });
    assert.equal(row.normalizedEmail, "alias.user@example.com");
    assert.equal(row.verificationStatus, "user_unverified");

    const other = await createUser("mail_other");
    await emails.removeAlias({ userId: other, emailId: row.id });
    assert.equal(
      await prisma.userEmail.count({ where: { id: row.id } }),
      1,
      "other user cannot delete alias",
    );

    await emails.removeAlias({ userId, emailId: row.id });
    assert.equal(await prisma.userEmail.count({ where: { id: row.id } }), 0);
  });

  it("metric DTOs never expose forbidden verdict keys", async () => {
    const userId = await createUser("metrics");
    const pat = `glpat-dash-${suiteId}-m`;
    await connect(userId, pat);
    await projects.enable({
      userId,
      gitlabInstanceId: instanceId,
      gitlabProjectId: "701",
    });
    const result = await dashboard.query(userId);
    for (const metric of result.metrics) {
      const record = metric as unknown as Record<string, unknown>;
      for (const key of FORBIDDEN_METRIC_KEYS) {
        assert.equal(Object.prototype.hasOwnProperty.call(record, key), false);
      }
      assert.ok(
        metric.status === "ok" ||
          metric.status === "not_configured" ||
          metric.status === "unknown",
      );
    }
    assert.ok(
      result.metrics.some((m) => m.metric === "loc_weekly" && m.status === "not_configured"),
    );
  });
});
