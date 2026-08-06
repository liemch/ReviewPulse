-- WP3/WP4: additive auth lockout + instance allowlist metadata.
-- Non-destructive: no drops, renames, or plaintext secret columns.

ALTER TABLE "users" ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMP(3);

ALTER TABLE "gitlab_instance_allowlist" ADD COLUMN "label" TEXT;
ALTER TABLE "gitlab_instance_allowlist" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;
