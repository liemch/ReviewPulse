/** Admin user lifecycle — create/invite, deactivate, reset password. */

import type { PrismaClient, UserRole } from "@reviewpulse/db";

import { AuditWriter } from "./audit.js";
import { normalizeEmail } from "./email.js";
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
} from "./errors.js";
import { hashPassword } from "./password.js";
import type { AuthUser } from "./session-service.js";
import { SessionService } from "./session-service.js";

const ROLES: ReadonlySet<string> = new Set([
  "admin",
  "tech_lead",
  "developer",
]);

export class UserAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly audit: AuditWriter,
  ) {}

  async createUser(input: {
    actor: AuthUser;
    email: string;
    password: string;
    role: UserRole;
    invited?: boolean;
  }): Promise<AuthUser> {
    if (input.actor.role !== "admin") {
      throw new ForbiddenError({ reason: "admin_only" });
    }
    if (!ROLES.has(input.role)) {
      throw new InvalidInputError({ reason: "bad_role" });
    }

    const normalized = normalizeEmail(input.email);
    const passwordHashArgon2id = await hashPassword(input.password);

    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email.trim(),
          normalizedEmail: normalized,
          passwordHashArgon2id,
          role: input.role,
          createdByAdminId: input.actor.id,
          invitedAt: input.invited ? new Date() : null,
        },
      });
      await this.audit.write(
        input.invited ? "user_invited" : "user_created",
        input.actor.id,
        { targetUserId: user.id, role: user.role },
      );
      return {
        id: user.id,
        email: user.email,
        normalizedEmail: user.normalizedEmail,
        role: user.role,
        status: user.status,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002") {
        throw new ConflictError({ reason: "email_taken" });
      }
      throw error;
    }
  }

  async listUsers(actor: AuthUser): Promise<AuthUser[]> {
    if (actor.role !== "admin") {
      throw new ForbiddenError({ reason: "admin_only" });
    }
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        normalizedEmail: true,
        role: true,
        status: true,
      },
    });
    return rows;
  }

  async deactivateUser(input: {
    actor: AuthUser;
    userId: string;
  }): Promise<void> {
    if (input.actor.role !== "admin") {
      throw new ForbiddenError({ reason: "admin_only" });
    }
    if (input.actor.id === input.userId) {
      throw new InvalidInputError({ reason: "cannot_deactivate_self" });
    }
    const existing = await this.prisma.user.findUnique({
      where: { id: input.userId },
    });
    if (existing === null) {
      throw new NotFoundError({ reason: "user" });
    }
    await this.prisma.user.update({
      where: { id: input.userId },
      data: { status: "deactivated" },
    });
    await this.sessions.revokeAllForUser(input.userId, input.actor.id);
    await this.audit.write("user_deactivated", input.actor.id, {
      targetUserId: input.userId,
    });
  }

  async resetPassword(input: {
    actor: AuthUser;
    userId: string;
    newPassword: string;
  }): Promise<void> {
    if (input.actor.role !== "admin") {
      throw new ForbiddenError({ reason: "admin_only" });
    }
    const passwordHashArgon2id = await hashPassword(input.newPassword);
    const existing = await this.prisma.user.findUnique({
      where: { id: input.userId },
    });
    if (existing === null) {
      throw new NotFoundError({ reason: "user" });
    }
    await this.prisma.user.update({
      where: { id: input.userId },
      data: {
        passwordHashArgon2id,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await this.sessions.revokeAllForUser(input.userId, input.actor.id);
    await this.audit.write("password_reset_by_admin", input.actor.id, {
      targetUserId: input.userId,
    });
  }
}
