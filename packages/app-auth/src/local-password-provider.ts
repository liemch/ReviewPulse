/** Local email/password AppAuthProvider. */

import type { PrismaClient, UserRole } from "@reviewpulse/db";

import { AuditWriter } from "./audit.js";
import { normalizeEmail } from "./email.js";
import {
  AccountDeactivatedError,
  AccountLockedError,
  InvalidCredentialsError,
} from "./errors.js";
import { LockoutService } from "./lockout.js";
import { verifyPassword } from "./password.js";
import type { AuthUser } from "./session-service.js";
import { SessionService } from "./session-service.js";
import type { SessionPolicy } from "./session-crypto.js";

export type AppUser = AuthUser;

export interface AppAuthProvider {
  verifyLocalLogin(email: string, password: string): Promise<AppUser>;
}

export type LoginResult = {
  readonly user: AuthUser;
  readonly sessionToken: string;
  readonly sessionId: string;
};

export type LocalPasswordAuthDeps = {
  readonly prisma: PrismaClient;
  readonly sessions: SessionService;
  readonly lockout: LockoutService;
  readonly audit: AuditWriter;
  readonly policy: SessionPolicy;
};

export class LocalPasswordAuthProvider implements AppAuthProvider {
  constructor(private readonly deps: LocalPasswordAuthDeps) {}

  async verifyLocalLogin(email: string, password: string): Promise<AppUser> {
    const result = await this.login({ email, password });
    return result.user;
  }

  async login(input: {
    email: string;
    password: string;
    userAgent?: string | null;
    ip?: string | null;
    priorSessionId?: string | null;
  }): Promise<LoginResult> {
    this.deps.lockout.assertIpAllowed(input.ip);

    let normalized: string;
    try {
      normalized = normalizeEmail(input.email);
    } catch {
      await this.deps.lockout.recordFailure(null, input.ip);
      await this.deps.audit.write("login_failure", null, {
        reason: "bad_email",
      });
      throw new InvalidCredentialsError();
    }

    const user = await this.deps.prisma.user.findUnique({
      where: { normalizedEmail: normalized },
    });

    // Constant-ish path: always verify against a dummy when user missing.
    const hash =
      user?.passwordHashArgon2id ??
      "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ok = await verifyPassword(hash, input.password);

    if (user === null || !ok) {
      await this.deps.lockout.recordFailure(user?.id ?? null, input.ip);
      await this.deps.audit.write("login_failure", user?.id ?? null, {
        reason: "invalid_credentials",
      });
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AccountLockedError();
    }
    if (user.status !== "active") {
      await this.deps.audit.write("login_failure", user.id, {
        reason: "deactivated",
      });
      throw new AccountDeactivatedError();
    }

    await this.deps.lockout.recordSuccess(user.id);

    const created = await this.deps.sessions.createSession({
      userId: user.id,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      rotateFromSessionId: input.priorSessionId ?? null,
    });

    await this.deps.audit.write("login_success", user.id, {
      sessionId: created.session.id,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        normalizedEmail: user.normalizedEmail,
        role: user.role as UserRole,
        status: user.status,
      },
      sessionToken: created.token,
      sessionId: created.session.id,
    };
  }
}
