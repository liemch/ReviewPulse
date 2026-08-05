/** WP1 — PAT credential persistence on top of the AES-256-GCM envelope. */

export {
  ActiveCredentialExistsError,
  ConcurrentCredentialReplaceError,
  ConnectionNotFoundError,
  CredentialError,
  CredentialStoreFailedError,
  CredentialUnreadableError,
  InvalidInvalidationReasonError,
  InvalidPatError,
  isCredentialError,
  isForeignKeyViolation,
  isUniqueViolation,
  NoActiveCredentialError,
  type CredentialErrorCode,
} from "./errors.js";
export { assertValidPat, patHintLast4 } from "./pat-policy.js";
export {
  createPatCredentialProvider,
  PrismaPatCredentialProvider,
  type GitLabCredentialProvider,
  type InvalidateReason,
  type PatCredentialProvider,
  type PatCredentialProviderDeps,
  type StoredCredentialRef,
} from "./pat-credential-provider.js";

export const PACKAGE_NAME = "@reviewpulse/credentials" as const;
