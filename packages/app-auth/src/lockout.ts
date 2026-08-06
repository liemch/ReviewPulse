/** Login rate limit + temporary account lockout. */

import type { PrismaClient } from "@reviewpulse/db";

import { AccountLockedError, RateLimitedError } from "./errors.js";
import { hashFingerprint } from "./session-crypto.js";

/** Locked decision S10: 5 failures → 15 min lock. */
const FAILURES_BEFORE_LOCK = 5;
const LOCK_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 60_000;
const IP_MAX_FAILURES = 20;

type IpBucket = { count: number; resetAt: number };

/** Process-local IP buckets — fine for single-node M1; not a distributed limiter. */
const ipBuckets = new Map<string, IpBucket>();

export class LockoutService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessionSecret: string,
  ) {}

  assertIpAllowed(ip: string | null | undefined): void {
    const key = hashFingerprint(ip ?? "unknown", this.sessionSecret) ?? "unknown";
    const now = Date.now();
    const bucket = ipBuckets.get(key);
    if (bucket && bucket.resetAt > now && bucket.count >= IP_MAX_FAILURES) {
      throw new RateLimitedError({ reason: "ip" });
    }
  }

  async assertUserNotLocked(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AccountLockedError();
    }
  }

  async recordFailure(
    userId: string | null,
    ip: string | null | undefined,
  ): Promise<void> {
    const key = hashFingerprint(ip ?? "unknown", this.sessionSecret) ?? "unknown";
    const now = Date.now();
    const bucket = ipBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      ipBuckets.set(key, { count: 1, resetAt: now + IP_WINDOW_MS });
    } else {
      bucket.count += 1;
    }

    if (userId === null) {
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { failedLoginCount: true, lockedUntil: true },
    });
    if (user === null) {
      return;
    }

    const nextCount = user.failedLoginCount + 1;
    const lockedUntil =
      nextCount >= FAILURES_BEFORE_LOCK
        ? new Date(now + LOCK_MS)
        : user.lockedUntil;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: nextCount,
        lockedUntil,
      },
    });
  }

  async recordSuccess(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });
  }

  /** Test helper — clears process-local IP buckets. */
  static clearIpBucketsForTests(): void {
    ipBuckets.clear();
  }
}
