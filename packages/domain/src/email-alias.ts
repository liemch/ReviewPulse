/**
 * WP7 — User email alias management (self only; no peer grant).
 */

import type { PrismaClient } from "@reviewpulse/db";
import { normalizeAuthorEmail } from "./sync-orchestrator.js";

export type UserEmailView = {
  id: string;
  email: string;
  normalizedEmail: string;
  source: string;
  verificationStatus: string;
  isPrimary: boolean;
};

export class EmailAliasService {
  constructor(private readonly prisma: PrismaClient) {}

  async listForUser(userId: string): Promise<UserEmailView[]> {
    const rows = await this.prisma.userEmail.findMany({
      where: { userId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      source: row.source,
      verificationStatus: row.verificationStatus,
      isPrimary: row.isPrimary,
    }));
  }

  async addAlias(input: {
    userId: string;
    email: string;
  }): Promise<UserEmailView> {
    const trimmed = input.email.trim();
    const normalized = normalizeAuthorEmail(trimmed);
    if (normalized === null) {
      throw new Error("Invalid email address");
    }
    const existing = await this.prisma.userEmail.findFirst({
      where: { userId: input.userId, normalizedEmail: normalized },
    });
    if (existing) {
      return {
        id: existing.id,
        email: existing.email,
        normalizedEmail: existing.normalizedEmail,
        source: existing.source,
        verificationStatus: existing.verificationStatus,
        isPrimary: existing.isPrimary,
      };
    }
    const row = await this.prisma.userEmail.create({
      data: {
        userId: input.userId,
        email: trimmed,
        normalizedEmail: normalized,
        source: "user_alias",
        verificationStatus: "user_unverified",
        isPrimary: false,
      },
    });
    return {
      id: row.id,
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      source: row.source,
      verificationStatus: row.verificationStatus,
      isPrimary: row.isPrimary,
    };
  }

  async removeAlias(input: {
    userId: string;
    emailId: string;
  }): Promise<void> {
    const row = await this.prisma.userEmail.findFirst({
      where: { id: input.emailId, userId: input.userId },
    });
    if (row === null) {
      return;
    }
    if (row.source !== "user_alias") {
      throw new Error("Only user-added aliases can be removed");
    }
    await this.prisma.userEmail.delete({ where: { id: row.id } });
  }
}
