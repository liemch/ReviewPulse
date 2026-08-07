/**
 * WP3b GitLab connection + WP4 allowlist/enable services.
 */

import type { PrismaClient } from "@reviewpulse/db";
import {
  createPatCredentialProvider,
  type PatCredentialProvider,
} from "@reviewpulse/credentials";
import {
  AesGcmSecretSealer,
  createEnvKeyLoader,
  type SecretSealer,
} from "@reviewpulse/crypto";

export type {
  JobQueue,
  ProjectAccessService,
  ProjectRef,
  SyncJob,
  SyncJobSpec,
} from "./types.js";

export {
  AllowlistAdminService,
  type InstanceAllowlistRow,
  type ProjectAllowlistRow,
} from "./allowlist-admin.js";
export {
  DEFAULT_MEMBERSHIP_CACHE_NEGATIVE_TTL_SECONDS,
  DEFAULT_MEMBERSHIP_CACHE_TTL_SECONDS,
  membershipCacheNegativeTtlFromEnv,
  membershipCacheTtlFromEnv,
  parseMembershipCacheNegativeTtlSeconds,
  parseMembershipCacheTtlSeconds,
} from "./membership-cache-config.js";
export {
  MembershipCacheStore,
  type MembershipCacheLookup,
} from "./membership-cache.js";
export {
  MAX_SYNC_JOB_ATTEMPTS,
  PostgresJobQueue,
  PrismaJobQueue,
  PROJECT_SYNC_JOB_TYPE,
  sanitizeJobError,
} from "./job-queue.js";
export {
  COMMIT_COLD_START_SINCE,
  createDefaultSyncGitLabClient,
  normalizeAuthorEmail,
  PrismaSyncPersistence,
  SyncBlockedError,
  SyncOrchestrator,
  type SyncBlockedOutcome,
  type SyncBudget,
  type SyncCompletedOutcome,
  type SyncGitLabClient,
  type SyncGitLabClientFactory,
  type SyncOutcome,
  type SyncPausedOutcome,
  type SyncPersistence,
  type SyncProject,
} from "./sync-orchestrator.js";
export {
  SyncScheduler,
  type SyncScheduleResult,
  type SyncSchedulerOptions,
} from "./sync-scheduler.js";
export {
  ConnectionPolicyError,
  createGitLabIdentityProbe,
  GitLabConnectionService,
  type ConnectionView,
  type GitLabIdentityProbe,
  type TestConnectionResult,
} from "./gitlab-connection.js";
export {
  createAllowlistedProjectProbe,
  LiveProjectAccessService,
  probeAllowlistedProjectIds,
  type AllowlistedProbeResult,
  type AllowlistedProjectProbe,
  type ProjectListItem,
  type VisibleProject,
} from "./project-access.js";

export function createDefaultSealer(
  env: Record<string, string | undefined> = process.env,
): SecretSealer {
  const loader = createEnvKeyLoader(env as NodeJS.ProcessEnv);
  return new AesGcmSecretSealer(loader);
}

export function createDefaultCredentialProvider(
  prisma: PrismaClient,
  sealer: SecretSealer = createDefaultSealer(),
): PatCredentialProvider {
  return createPatCredentialProvider({ prisma, sealer });
}

export type { PatCredentialProvider, SecretSealer };

export const PACKAGE_NAME = "@reviewpulse/domain" as const;
