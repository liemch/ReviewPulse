-- WP1: additive, non-destructive AES-256-GCM envelope columns for user_credentials.
-- No column is dropped, renamed, or retyped; no plaintext PAT column is introduced.
-- "auth_tag" is added NOT NULL without a default: the table carries no rows before WP1
-- (nothing wrote credentials in WP0), so this fails loudly instead of backfilling a
-- forged authentication tag if that assumption is ever wrong.

-- CreateEnum
CREATE TYPE "CredentialInvalidationReason" AS ENUM ('gitlab_unauthorized', 'expired', 'user_revoked', 'user_deleted', 'connection_deleted');

-- AlterTable
ALTER TABLE "user_credentials" ADD COLUMN "auth_tag" BYTEA NOT NULL;
ALTER TABLE "user_credentials" ADD COLUMN "envelope_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "user_credentials" ADD COLUMN "invalidation_reason" "CredentialInvalidationReason";
