/** Server-side PostgreSQL sessions. */

import type { PrismaClient, UserRole, UserStatus } from "@reviewpulse/db";

import { AuditWriter } from "./audit.js";
import {
  AccountDeactivatedError,
  SessionExpiredError,
  UnauthorizedError,
} from "./errors.js";
import {
  hashFingerprint,
  hashSessionToken,
  mintSessionToken,
  type SessionPolicy,
} from "./session-crypto.js";

export type AuthUser = {
  readonly id: string;
  readonly email: string;
  readonly normalizedEmail: string;
  readonly role: UserRole;
  readonly status: UserStatus;
};

export type SessionRecord = {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
};

export type ValidatedSession = {
  readonly session: SessionRecord;
  readonly user: AuthUser;
  /** Present only when a sliding idle touch updated lastSeenAt. */
  readonly touched: boolean;
};

export type CreateSessionInput = {
  readonly userId: string;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
  readonly rotateFromSessionId?: string | null;
};

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: SessionPolicy,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Creates a session and returns the **plaintext** opaque token for the
   * Set-Cookie header. The DB only ever stores the HMAC hash.
   */
  async createSession(input: CreateSessionInput): Promise<{
    token: string;
    session: SessionRecord;
  }> {
    const token = mintSessionToken();
    const tokenHash = hashSessionToken(token, this.policy.sessionSecret);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.policy.absTtlSeconds * 1000,
    );

    if (input.rotateFromSessionId) {
      await this.prisma.session.updateMany({
        where: {
          id: input.rotateFromSessionId,
          userId: input.userId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
    }

    const row = await this.prisma.session.create({
      data: {
        userId: input.userId,
        tokenHash,
        expiresAt,
        lastSeenAt: now,
        rotatedFrom: input.rotateFromSessionId ?? null,
        userAgentHash: hashFingerprint(
          input.userAgent,
          this.policy.sessionSecret,
        ),
        ipHash: hashFingerprint(input.ip, this.policy.sessionSecret),
      },
    });

    return {
      token,
      session: {
        id: row.id,
        userId: row.userId,
        expiresAt: row.expiresAt,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
      },
    };
  }

  async validateToken(
    token: string | undefined | null,
  ): Promise<ValidatedSession> {
    if (typeof token !== "string" || token.length === 0) {
      throw new UnauthorizedError({ reason: "missing_token" });
    }
    const tokenHash = hashSessionToken(token, this.policy.sessionSecret);
    const row = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            normalizedEmail: true,
            role: true,
            status: true,
          },
        },
      },
    });

    if (row === null || row.revokedAt !== null) {
      throw new UnauthorizedError({ reason: "unknown_session" });
    }

    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new SessionExpiredError({ reason: "absolute" });
    }

    const idleDeadline =
      row.lastSeenAt.getTime() + this.policy.idleTtlSeconds * 1000;
    if (idleDeadline <= now.getTime()) {
      await this.prisma.session.update({
        where: { id: row.id },
        data: { revokedAt: now },
      });
      throw new SessionExpiredError({ reason: "idle" });
    }

    if (row.user.status !== "active") {
      throw new AccountDeactivatedError();
    }

    // Sliding idle window — touch at most once per 60s to cut write chatter.
    let touched = false;
    if (now.getTime() - row.lastSeenAt.getTime() > 60_000) {
      await this.prisma.session.update({
        where: { id: row.id },
        data: { lastSeenAt: now },
      });
      touched = true;
    }

    return {
      session: {
        id: row.id,
        userId: row.userId,
        expiresAt: row.expiresAt,
        lastSeenAt: touched ? now : row.lastSeenAt,
        createdAt: row.createdAt,
      },
      user: row.user,
      touched,
    };
  }

  async revokeSession(
    sessionId: string,
    actorUserId: string | null,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
    await this.audit.write("logout", actorUserId, { sessionId });
  }

  async revokeAllForUser(
    userId: string,
    actorUserId: string | null,
  ): Promise<number> {
    const now = new Date();
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await this.audit.write("sessions_revoked", actorUserId, {
      targetUserId: userId,
      count: result.count,
    });
    return result.count;
  }
}
