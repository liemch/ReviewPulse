/**
 * WP3 PostgreSQL integration tests: sessions, rotation, expiry, lockout,
 * deactivation, and audit hygiene against real rows.
 *
 * Requires a migrated database via DATABASE_URL. The shared setup loads the
 * monorepo root `.env` and fails loudly when PostgreSQL is unavailable.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { getPrisma, type PrismaClient } from "@reviewpulse/db";
import { requirePostgresIntegrationDatabase } from "@reviewpulse/db/integration-test-setup";

import { AuditWriter } from "./audit.js";
import {
  AccountDeactivatedError,
  AccountLockedError,
  InvalidCredentialsError,
  SessionExpiredError,
  UnauthorizedError,
} from "./errors.js";
import { LocalPasswordAuthProvider } from "./local-password-provider.js";
import { LockoutService } from "./lockout.js";
import { loadSessionPolicy, type SessionPolicy } from "./session-crypto.js";
import { SessionService, type AuthUser } from "./session-service.js";
import { UserAdminService } from "./user-admin.js";

const SESSION_SECRET = "integration-only-session-secret-0123456789";
const PASSWORD = "correct-horse-battery-staple";

await requirePostgresIntegrationDatabase("AppAuth integration tests");

describe("WP3 AppAuth (PostgreSQL)", () => {
  const prisma: PrismaClient = getPrisma();
  const policy: SessionPolicy = loadSessionPolicy({
    SESSION_SECRET,
    NODE_ENV: "test",
  });

  const audit = new AuditWriter(prisma);
  const sessions = new SessionService(prisma, policy, audit);
  const lockout = new LockoutService(prisma, policy.sessionSecret);
  const auth = new LocalPasswordAuthProvider({
    prisma,
    sessions,
    lockout,
    audit,
    policy,
  });
  const users = new UserAdminService(prisma, sessions, audit);

  const fixtureUserIds = new Set<string>();

  function fixtureId(): string {
    return randomUUID().replace(/-/g, "");
  }

  /** Direct row insert: the bootstrap admin exists before any admin can act. */
  async function createAdmin(): Promise<AuthUser> {
    const id = `admin_${fixtureId()}`;
    const address = `${id}@authflow.test`;
    const row = await prisma.user.create({
      data: {
        id,
        email: address,
        normalizedEmail: address,
        passwordHashArgon2id: "not-a-real-hash",
        role: "admin",
      },
    });
    fixtureUserIds.add(row.id);
    return {
      id: row.id,
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      role: row.role,
      status: row.status,
    };
  }

  async function createMember(
    actor: AuthUser,
    password: string = PASSWORD,
  ): Promise<AuthUser> {
    const address = `member_${fixtureId()}@authflow.test`;
    const created = await users.createUser({
      actor,
      email: address,
      password,
      role: "developer",
    });
    fixtureUserIds.add(created.id);
    return created;
  }

  afterEach(async () => {
    LockoutService.clearIpBucketsForTests();
    const ids = [...fixtureUserIds];
    fixtureUserIds.clear();
    if (ids.length === 0) {
      return;
    }
    // Audit rows survive user deletion (actor_user_id ON DELETE SET NULL).
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("stores an Argon2id hash and never the plaintext password", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
    });
    assert.match(row.passwordHashArgon2id, /^\$argon2id\$/);
    assert.equal(row.passwordHashArgon2id.includes(PASSWORD), false);
    assert.equal(JSON.stringify(row).includes(PASSWORD), false);
  });

  it("logs in, stores only a token hash, and rotates the prior session", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);

    const first = await auth.login({
      email: member.email,
      password: PASSWORD,
      ip: `10.0.0.${Math.floor(Math.random() * 200) + 1}`,
      userAgent: "integration-agent",
    });

    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: first.sessionId },
    });
    assert.notEqual(stored.tokenHash, first.sessionToken);
    assert.equal(JSON.stringify(stored).includes(first.sessionToken), false);
    assert.equal(stored.userAgentHash === "integration-agent", false);

    const second = await auth.login({
      email: member.email,
      password: PASSWORD,
      priorSessionId: first.sessionId,
    });

    assert.notEqual(second.sessionId, first.sessionId);
    const rotated = await prisma.session.findUniqueOrThrow({
      where: { id: second.sessionId },
    });
    assert.equal(rotated.rotatedFrom, first.sessionId);

    // Session fixation: the pre-rotation token must no longer authenticate.
    await assert.rejects(
      () => sessions.validateToken(first.sessionToken),
      UnauthorizedError,
    );
    const live = await sessions.validateToken(second.sessionToken);
    assert.equal(live.user.id, member.id);
  });

  it("rejects a session past its idle window and revokes the row", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const login = await auth.login({ email: member.email, password: PASSWORD });

    const beyondIdle = new Date(
      Date.now() - (policy.idleTtlSeconds + 60) * 1000,
    );
    await prisma.session.update({
      where: { id: login.sessionId },
      data: { lastSeenAt: beyondIdle },
    });

    await assert.rejects(
      () => sessions.validateToken(login.sessionToken),
      (error: unknown) =>
        error instanceof SessionExpiredError &&
        error.context["reason"] === "idle",
    );

    const row = await prisma.session.findUniqueOrThrow({
      where: { id: login.sessionId },
    });
    assert.notEqual(row.revokedAt, null);
  });

  it("rejects a session past its absolute expiry", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const login = await auth.login({ email: member.email, password: PASSWORD });

    await prisma.session.update({
      where: { id: login.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await assert.rejects(
      () => sessions.validateToken(login.sessionToken),
      (error: unknown) =>
        error instanceof SessionExpiredError &&
        error.context["reason"] === "absolute",
    );
  });

  it("issues an absolute expiry that matches the locked 12h policy", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const login = await auth.login({ email: member.email, password: PASSWORD });

    const row = await prisma.session.findUniqueOrThrow({
      where: { id: login.sessionId },
    });
    const ttlSeconds =
      (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000;
    assert.ok(
      Math.abs(ttlSeconds - policy.absTtlSeconds) < 60,
      `expected ~${policy.absTtlSeconds}s absolute TTL, got ${ttlSeconds}s`,
    );
    assert.equal(policy.absTtlSeconds, 43_200);
    assert.equal(policy.idleTtlSeconds, 7_200);
  });

  it("revoke-all kills every live session for the user only", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const other = await createMember(admin);

    const a = await auth.login({ email: member.email, password: PASSWORD });
    const b = await auth.login({ email: member.email, password: PASSWORD });
    const untouched = await auth.login({
      email: other.email,
      password: PASSWORD,
    });

    const revoked = await sessions.revokeAllForUser(member.id, member.id);
    assert.equal(revoked >= 1, true);

    await assert.rejects(() => sessions.validateToken(a.sessionToken));
    await assert.rejects(() => sessions.validateToken(b.sessionToken));
    const stillLive = await sessions.validateToken(untouched.sessionToken);
    assert.equal(stillLive.user.id, other.id);
  });

  it("deactivating a user revokes sessions and blocks the old cookie", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const login = await auth.login({ email: member.email, password: PASSWORD });

    await users.deactivateUser({ actor: admin, userId: member.id });

    const remaining = await prisma.session.count({
      where: { userId: member.id, revokedAt: null },
    });
    assert.equal(remaining, 0);
    await assert.rejects(() => sessions.validateToken(login.sessionToken));
    await assert.rejects(
      () => auth.login({ email: member.email, password: PASSWORD }),
      AccountDeactivatedError,
    );
  });

  it("locks the account after five failed logins", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const ip = "198.51.100.7";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        () =>
          auth.login({
            email: member.email,
            password: "definitely-wrong-password",
            ip,
          }),
        InvalidCredentialsError,
      );
    }

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
    });
    assert.equal(row.failedLoginCount >= 5, true);
    assert.notEqual(row.lockedUntil, null);

    // Even the correct password is refused while the lock holds.
    await assert.rejects(
      () => auth.login({ email: member.email, password: PASSWORD, ip }),
      AccountLockedError,
    );
  });

  it("clears the failure counter after a successful login", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const ip = "198.51.100.9";

    await assert.rejects(
      () => auth.login({ email: member.email, password: "wrong-password-1", ip }),
      InvalidCredentialsError,
    );
    await auth.login({ email: member.email, password: PASSWORD, ip });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
    });
    assert.equal(row.failedLoginCount, 0);
    assert.equal(row.lockedUntil, null);
    assert.notEqual(row.lastLoginAt, null);
  });

  it("admin password reset revokes sessions and accepts only the new password", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const login = await auth.login({ email: member.email, password: PASSWORD });
    const nextPassword = "rotated-password-9876";

    await users.resetPassword({
      actor: admin,
      userId: member.id,
      newPassword: nextPassword,
    });

    await assert.rejects(() => sessions.validateToken(login.sessionToken));
    await assert.rejects(
      () => auth.login({ email: member.email, password: PASSWORD }),
      InvalidCredentialsError,
    );
    const fresh = await auth.login({
      email: member.email,
      password: nextPassword,
    });
    assert.equal(fresh.user.id, member.id);
  });

  it("normalizes email so a differently-cased login still resolves", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);

    const login = await auth.login({
      email: `  ${member.email.toUpperCase()} `,
      password: PASSWORD,
    });
    assert.equal(login.user.id, member.id);
  });

  it("keeps passwords and session tokens out of audit rows", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const login = await auth.login({ email: member.email, password: PASSWORD });
    await sessions.revokeSession(login.sessionId, member.id);

    const events = await prisma.auditEvent.findMany({
      where: { actorUserId: { in: [admin.id, member.id] } },
    });
    assert.ok(events.length >= 2);

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal(serialized.includes(login.sessionToken), false);
    for (const event of events) {
      const meta = JSON.stringify(event.metaJsonSafe ?? {}).toLowerCase();
      for (const banned of ["password", "\"pat\"", "token", "secret"]) {
        assert.equal(meta.includes(banned), false, `${event.action}: ${banned}`);
      }
    }

    const actions = events.map((event) => event.action);
    assert.ok(actions.includes("user_created"));
    assert.ok(actions.includes("login_success"));
  });

  it("records a login failure without inventing a session", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);

    await assert.rejects(
      () =>
        auth.login({
          email: member.email,
          password: "another-wrong-password",
          ip: "203.0.113.44",
        }),
      InvalidCredentialsError,
    );

    assert.equal(
      await prisma.session.count({ where: { userId: member.id } }),
      0,
    );
    const failures = await prisma.auditEvent.count({
      where: { actorUserId: member.id, action: "login_failure" },
    });
    assert.equal(failures, 1);
  });

  it("refuses non-admin actors on admin user operations", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);
    const victim = await createMember(admin);

    await assert.rejects(
      () =>
        users.createUser({
          actor: member,
          email: `escalation_${fixtureId()}@authflow.test`,
          password: PASSWORD,
          role: "admin",
        }),
      (error: unknown) => (error as { code?: string }).code === "AUTH_FORBIDDEN",
    );
    await assert.rejects(
      () => users.deactivateUser({ actor: member, userId: victim.id }),
      (error: unknown) => (error as { code?: string }).code === "AUTH_FORBIDDEN",
    );
    await assert.rejects(
      () => users.listUsers(member),
      (error: unknown) => (error as { code?: string }).code === "AUTH_FORBIDDEN",
    );

    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: victim.id },
    });
    assert.equal(untouched.status, "active");
  });

  it("rejects a duplicate email regardless of case", async () => {
    const admin = await createAdmin();
    const member = await createMember(admin);

    await assert.rejects(
      () =>
        users.createUser({
          actor: admin,
          email: member.email.toUpperCase(),
          password: PASSWORD,
          role: "developer",
        }),
      (error: unknown) => (error as { code?: string }).code === "AUTH_CONFLICT",
    );
  });
});
