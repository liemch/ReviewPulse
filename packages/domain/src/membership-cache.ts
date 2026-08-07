/**
 * WP5 membership cache — per user + GitLab instance + project.
 * Fresh hits may short-circuit GitLab probes; expired/missing always re-probe.
 */

import type { PrismaClient } from "@reviewpulse/db";

import {
  DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS,
  parseMembershipCacheNegativeTtlSeconds,
} from "./membership-cache-config.js";

export type MembershipCacheLookup =
  | { kind: "fresh"; allowed: boolean }
  | { kind: "miss" }
  | { kind: "expired" };

export class MembershipCacheStore {
  private readonly negativeTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlSeconds = DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS,
    negativeTtlSeconds?: number,
  ) {
    this.negativeTtlSeconds = Math.min(
      negativeTtlSeconds ?? parseMembershipCacheNegativeTtlSeconds(undefined, ttlSeconds),
      ttlSeconds,
    );
  }

  async lookup(
    userId: string,
    gitlabInstanceId: string,
    gitlabProjectId: string,
    now: Date = new Date(),
  ): Promise<MembershipCacheLookup> {
    const row = await this.prisma.membershipCache.findUnique({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId,
          gitlabInstanceId,
          gitlabProjectId,
        },
      },
      select: { allowed: true, expiresAt: true },
    });
    if (row === null) {
      return { kind: "miss" };
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      return { kind: "expired" };
    }
    return { kind: "fresh", allowed: row.allowed };
  }

  /** Fresh rows only — expired entries are omitted so callers must re-probe. */
  async lookupFreshMany(
    userId: string,
    gitlabInstanceId: string,
    projectIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, boolean>> {
    if (projectIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.membershipCache.findMany({
      where: {
        userId,
        gitlabInstanceId,
        gitlabProjectId: { in: [...projectIds] },
        expiresAt: { gt: now },
      },
      select: { gitlabProjectId: true, allowed: true },
    });
    return new Map(rows.map((row) => [row.gitlabProjectId, row.allowed]));
  }

  async write(
    userId: string,
    gitlabInstanceId: string,
    gitlabProjectId: string,
    allowed: boolean,
    now: Date = new Date(),
  ): Promise<void> {
    const checkedAt = now;
    const ttlSeconds = allowed ? this.ttlSeconds : this.negativeTtlSeconds;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    await this.prisma.membershipCache.upsert({
      where: {
        userId_gitlabInstanceId_gitlabProjectId: {
          userId,
          gitlabInstanceId,
          gitlabProjectId,
        },
      },
      create: {
        userId,
        gitlabInstanceId,
        gitlabProjectId,
        allowed,
        checkedAt,
        expiresAt,
      },
      update: {
        allowed,
        checkedAt,
        expiresAt,
      },
    });
  }

  async invalidateUser(userId: string): Promise<void> {
    await this.prisma.membershipCache.deleteMany({ where: { userId } });
  }

  async invalidateUserInstance(
    userId: string,
    gitlabInstanceId: string,
  ): Promise<void> {
    await this.prisma.membershipCache.deleteMany({
      where: { userId, gitlabInstanceId },
    });
  }

  async invalidateUserProject(
    userId: string,
    gitlabInstanceId: string,
    gitlabProjectId: string,
  ): Promise<void> {
    await this.prisma.membershipCache.deleteMany({
      where: { userId, gitlabInstanceId, gitlabProjectId },
    });
  }

  async invalidateInstance(gitlabInstanceId: string): Promise<void> {
    await this.prisma.membershipCache.deleteMany({
      where: { gitlabInstanceId },
    });
  }

  async invalidateProject(
    gitlabInstanceId: string,
    gitlabProjectId: string,
  ): Promise<void> {
    await this.prisma.membershipCache.deleteMany({
      where: { gitlabInstanceId, gitlabProjectId },
    });
  }
}
