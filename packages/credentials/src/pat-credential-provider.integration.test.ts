/**
 * PostgreSQL integration tests for the PAT credential provider.
 *
 * Requires a migrated database via DATABASE_URL. The shared setup loads the
 * monorepo root `.env` and fails loudly when PostgreSQL is unavailable.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";

import {
  AesGcmSecretSealer,
  createStaticKeyLoader,
  type SealedSecret,
  type SecretBinding,
  type SecretSealer,
} from "@reviewpulse/crypto";
import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import {
  PrismaPatCredentialProvider,
  type InvalidateReason,
  type PatCredentialProvider,
} from "./pat-credential-provider.js";

const PAT_ONE = "glpat-integration-one-0000000001";
const PAT_TWO = "glpat-integration-two-0000000002";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");

await requirePostgresIntegrationDatabase("Credential integration tests");

describe("PrismaPatCredentialProvider (PostgreSQL)", () => {
  const prisma: PrismaClient = getPrisma();
  const sealer = new AesGcmSecretSealer(
    createStaticKeyLoader(ENCRYPTION_KEY, "v1"),
  );
  const provider: PatCredentialProvider = new PrismaPatCredentialProvider({
    prisma,
    sealer,
  });

  const suiteId = randomUUID().replace(/-/g, "");
  const instanceId = `inst_${suiteId}`;

  /**
   * Users created by the test currently running. Deleting a user cascades to
   * its connections and their credentials, so the root id is the whole cleanup.
   */
  const fixtureUserIds = new Set<string>();
  const cleanupFailures: string[] = [];

  /**
   * Every connection gets its own ReviewPulse user and its own GitLab identity.
   *
   * Sharing one user across connections violates
   * `gitlab_connections_one_active_per_user_instance`, and sharing one GitLab
   * user id violates `gitlab_connections_one_live_identity`. Reusing the
   * instance is fine because both sides of each index still differ.
   */
  async function createConnection(): Promise<string> {
    const fixtureId = randomUUID().replace(/-/g, "");
    const userId = `user_${suiteId}_${fixtureId}`;
    const address = `${userId}@integration.test`;

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

    const connection = await prisma.gitLabConnection.create({
      data: {
        userId,
        gitlabInstanceId: instanceId,
        gitlabUserId: `gl_${fixtureId}`,
        gitlabUsername: `integration-${fixtureId.slice(0, 8)}`,
        status: "active",
      },
    });
    return connection.id;
  }

  async function activeCredentials(connectionId: string) {
    return prisma.userCredential.findMany({
      where: { connectionId, status: "active" },
    });
  }

  before(async () => {
    await prisma.gitLabInstanceAllowlist.create({
      data: {
        id: instanceId,
        baseUrlNormalized: `https://gitlab-${suiteId}.example.com`,
      },
    });
  });

  /**
   * Scoped to the ids this test created, so a suite running in parallel is
   * untouched. A cleanup error is collected rather than thrown: throwing here
   * would replace the real assertion failure with a teardown error. The
   * collected list is asserted once at the end instead.
   */
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

  it("stores a sealed credential with no plaintext PAT in any column", async () => {
    const connectionId = await createConnection();
    const stored = await provider.storeCredential(connectionId, PAT_ONE);

    assert.equal(stored.patHintLast4, "0001");

    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "user_credentials" WHERE "connection_id" = ${connectionId}
    `;
    assert.equal(rows.length, 1);

    const dumped = JSON.stringify(rows, (_key, value: unknown) =>
      value instanceof Uint8Array
        ? Buffer.from(value).toString("hex")
        : (value as unknown),
    );
    assert.ok(!dumped.includes(PAT_ONE), "plaintext PAT must not reach the database");
    assert.ok(
      !dumped.includes(Buffer.from(PAT_ONE, "utf8").toString("hex")),
      "plaintext PAT bytes must not reach the database",
    );

    const row = rows[0] as Record<string, unknown>;
    assert.equal(row.envelope_version, 1);
    assert.equal(row.key_version, 1);
    assert.equal(row.status, "active");
    assert.equal(row.invalidation_reason, null);
    assert.equal((row.nonce as Uint8Array).length, 12);
    assert.equal((row.auth_tag as Uint8Array).length, 16);
  });

  it("loads the plaintext back through getAccessToken", async () => {
    const connectionId = await createConnection();
    await provider.storeCredential(connectionId, PAT_ONE);

    assert.equal(await provider.getAccessToken(connectionId), PAT_ONE);
  });

  it("refuses a second store while a credential is active", async () => {
    const connectionId = await createConnection();
    await provider.storeCredential(connectionId, PAT_ONE);

    await assert.rejects(() => provider.storeCredential(connectionId, PAT_TWO), {
      code: "ACTIVE_CREDENTIAL_EXISTS",
    });
    assert.equal((await activeCredentials(connectionId)).length, 1);
  });

  it("rejects an unknown connection with a typed error", async () => {
    // The foreign key violation is the assertion; Prisma logs one expected
    // `prisma:error` line for it. The log carries the constraint name only —
    // no PAT and no ciphertext — and the provider still maps it to a safe code.
    await assert.rejects(
      () => provider.storeCredential(`missing_${randomUUID()}`, PAT_ONE),
      { code: "CONNECTION_NOT_FOUND" },
    );
  });

  it("replaces a PAT atomically and supersedes exactly one predecessor", async () => {
    const connectionId = await createConnection();
    const first = await provider.storeCredential(connectionId, PAT_ONE);
    const second = await provider.replaceCredential(connectionId, PAT_TWO);

    assert.notEqual(first.credentialId, second.credentialId);
    assert.equal(await provider.getAccessToken(connectionId), PAT_TWO);

    const rows = await prisma.userCredential.findMany({
      where: { connectionId },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.status === "active").length, 1);

    const superseded = rows.find((row) => row.id === first.credentialId);
    assert.equal(superseded?.status, "superseded");
    assert.equal(superseded?.invalidationReason, null);
    assert.equal(superseded?.revokedAt, null);
  });

  it("rolls back the whole replace when the new credential cannot be written", async () => {
    const connectionId = await createConnection();
    const original = await provider.storeCredential(connectionId, PAT_ONE);

    const failing: SecretSealer = {
      seal: async () => {
        throw new Error("seal failed");
      },
      open: (sealed: SealedSecret, binding: SecretBinding) =>
        sealer.open(sealed, binding),
    };
    const failingProvider = new PrismaPatCredentialProvider({
      prisma,
      sealer: failing,
    });

    await assert.rejects(() =>
      failingProvider.replaceCredential(connectionId, PAT_TWO),
    );

    const rows = await prisma.userCredential.findMany({ where: { connectionId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, original.credentialId);
    assert.equal(rows[0]?.status, "active");
    assert.equal(await provider.getAccessToken(connectionId), PAT_ONE);
  });

  it("keeps at most one active credential under concurrent replace", async () => {
    const connectionId = await createConnection();
    await provider.storeCredential(connectionId, PAT_ONE);

    const results = await Promise.allSettled([
      provider.replaceCredential(connectionId, PAT_TWO),
      provider.replaceCredential(connectionId, PAT_TWO),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length + rejected.length, 2);
    for (const failure of rejected) {
      const reason = (failure as PromiseRejectedResult).reason as {
        code?: string;
      };
      assert.equal(reason.code, "CONCURRENT_CREDENTIAL_REPLACE");
    }
    assert.equal((await activeCredentials(connectionId)).length, 1);
  });

  it("cannot open a ciphertext copied onto another connection", async () => {
    const sourceConnectionId = await createConnection();
    const targetConnectionId = await createConnection();

    await provider.storeCredential(sourceConnectionId, PAT_ONE);
    const source = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId: sourceConnectionId, status: "active" },
    });

    await prisma.userCredential.create({
      data: {
        id: randomUUID(),
        connectionId: targetConnectionId,
        ciphertext: source.ciphertext,
        authTag: source.authTag,
        nonce: source.nonce,
        envelopeVersion: source.envelopeVersion,
        keyVersion: source.keyVersion,
        patHintLast4: source.patHintLast4,
        status: "active",
      },
    });

    await assert.rejects(() => provider.getAccessToken(targetConnectionId), {
      code: "DECRYPTION_FAILED",
    });
  });

  it("fails closed when the credential was sealed under another key", async () => {
    const connectionId = await createConnection();
    await provider.storeCredential(connectionId, PAT_ONE);

    const otherKeyProvider = new PrismaPatCredentialProvider({
      prisma,
      sealer: new AesGcmSecretSealer(
        createStaticKeyLoader(randomBytes(32).toString("base64"), "v1"),
      ),
    });

    await assert.rejects(() => otherKeyProvider.getAccessToken(connectionId), {
      code: "DECRYPTION_FAILED",
    });
  });

  it("maps every invalidation reason to the locked status", async () => {
    const cases: [InvalidateReason, string][] = [
      ["gitlab_unauthorized", "invalid"],
      ["expired", "invalid"],
      ["user_revoked", "revoked"],
      ["user_deleted", "revoked"],
      ["connection_deleted", "revoked"],
    ];

    for (const [reason, expectedStatus] of cases) {
      const connectionId = await createConnection();
      await provider.storeCredential(connectionId, PAT_ONE);
      await provider.invalidateCredential(connectionId, reason);

      const rows = await prisma.userCredential.findMany({ where: { connectionId } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, expectedStatus);
      assert.equal(rows[0]?.invalidationReason, reason);
      assert.ok(rows[0]?.revokedAt instanceof Date);
    }
  });

  it("is idempotent on repeated invalidation and never reactivates", async () => {
    const connectionId = await createConnection();
    await provider.storeCredential(connectionId, PAT_ONE);

    await provider.invalidateCredential(connectionId, "user_revoked");
    const afterFirst = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId },
    });

    await provider.invalidateCredential(connectionId, "gitlab_unauthorized");
    const afterSecond = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId },
    });

    assert.equal(afterSecond.status, "revoked");
    assert.equal(afterSecond.invalidationReason, "user_revoked");
    assert.deepEqual(afterSecond.revokedAt, afterFirst.revokedAt);
    assert.equal((await activeCredentials(connectionId)).length, 0);
  });

  it("no-ops invalidation when nothing is active", async () => {
    const connectionId = await createConnection();
    await provider.invalidateCredential(connectionId, "connection_deleted");

    assert.equal((await prisma.userCredential.count({ where: { connectionId } })), 0);
  });

  it("reports a missing active credential without leaking secrets", async () => {
    const connectionId = await createConnection();
    await provider.storeCredential(connectionId, PAT_ONE);
    await provider.invalidateCredential(connectionId, "user_revoked");

    try {
      await provider.getAccessToken(connectionId);
      assert.fail("expected NO_ACTIVE_CREDENTIAL");
    } catch (error) {
      const serialized = `${String(error)}${JSON.stringify(error)}${
        (error as Error).stack ?? ""
      }`;
      assert.equal((error as { code?: string }).code, "NO_ACTIVE_CREDENTIAL");
      assert.ok(!serialized.includes(PAT_ONE));
      assert.ok(!serialized.includes(ENCRYPTION_KEY));
    }
  });

  it("creates no credential row for any rejected PAT", async () => {
    const connectionId = await createConnection();

    for (const pat of [
      "",
      "   ",
      ` ${PAT_ONE}`,
      `${PAT_ONE} `,
      `${PAT_ONE}\n`,
      `${PAT_ONE}\t`,
      `${PAT_ONE}\r`,
    ]) {
      await assert.rejects(() => provider.storeCredential(connectionId, pat), {
        code: "INVALID_PAT",
      });
    }

    assert.equal(await prisma.userCredential.count({ where: { connectionId } }), 0);
  });

  it("leaves the existing credential active when a replace is rejected", async () => {
    const connectionId = await createConnection();
    const original = await provider.storeCredential(connectionId, PAT_ONE);

    for (const pat of ["", "  ", ` ${PAT_TWO}`, `${PAT_TWO}\n`, `${PAT_TWO}\t`]) {
      await assert.rejects(() => provider.replaceCredential(connectionId, pat), {
        code: "INVALID_PAT",
      });
    }

    const rows = await prisma.userCredential.findMany({ where: { connectionId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, original.credentialId);
    assert.equal(rows[0]?.status, "active");
    assert.equal(await provider.getAccessToken(connectionId), PAT_ONE);
  });

  it("stores a valid PAT unchanged and derives the hint from it", async () => {
    const connectionId = await createConnection();
    const stored = await provider.storeCredential(connectionId, PAT_ONE);

    assert.equal(stored.patHintLast4, PAT_ONE.slice(-4));
    assert.equal(await provider.getAccessToken(connectionId), PAT_ONE);

    const row = await prisma.userCredential.findFirstOrThrow({
      where: { connectionId },
    });
    assert.equal(row.patHintLast4, PAT_ONE.slice(-4));
  });

  it("keeps a rejected PAT out of the error payload", async () => {
    const connectionId = await createConnection();

    try {
      await provider.storeCredential(connectionId, `${PAT_ONE}\n`);
      assert.fail("expected INVALID_PAT");
    } catch (error) {
      const serialized = `${String(error)}${JSON.stringify(error)}${
        (error as Error).stack ?? ""
      }`;
      assert.equal((error as { code?: string }).code, "INVALID_PAT");
      assert.ok(!serialized.includes(PAT_ONE));
    }
  });
});
