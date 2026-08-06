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
  ConnectionPolicyError,
  createGitLabIdentityProbe,
  GitLabConnectionService,
  type ConnectionView,
  type GitLabIdentityProbe,
  type TestConnectionResult,
} from "./gitlab-connection.js";
export {
  createVisibleProjectsLoader,
  LiveProjectAccessService,
  type ProjectListItem,
  type VisibleProject,
  type VisibleProjectsLoader,
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
