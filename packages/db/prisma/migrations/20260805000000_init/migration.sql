-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'tech_lead', 'developer');
CREATE TYPE "UserStatus" AS ENUM ('active', 'deactivated');
CREATE TYPE "EmailSource" AS ENUM ('gitlab_primary', 'gitlab_secondary', 'user_alias');
CREATE TYPE "EmailVerificationStatus" AS ENUM ('gitlab_verified', 'gitlab_unverified', 'user_unverified');
CREATE TYPE "ConnectionStatus" AS ENUM ('active', 'invalid', 'superseded', 'deleted');
CREATE TYPE "CredentialStatus" AS ENUM ('active', 'invalid', 'superseded', 'revoked');
CREATE TYPE "SyncJobStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'sync_blocked');
CREATE TYPE "KpiRuleStatus" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "gitlab_instance_allowlist" (
    "id" TEXT NOT NULL,
    "base_url_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gitlab_instance_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "password_hash_argon2id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_by_admin_id" TEXT,
    "invited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_emails" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "source" "EmailSource" NOT NULL,
    "verification_status" "EmailVerificationStatus" NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_emails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "gitlab_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_user_id" TEXT NOT NULL,
    "gitlab_username" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'active',
    "last_validated_at" TIMESTAMP(3),
    "expires_hint" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gitlab_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_credentials" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL,
    "nonce" BYTEA NOT NULL,
    "pat_hint_last4" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'active',
    "validated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_from" TEXT,
    "revoked_at" TIMESTAMP(3),
    "user_agent_hash" TEXT,
    "ip_hash" TEXT,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reviewpulse_project_allowlist" (
    "id" TEXT NOT NULL,
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "path_with_namespace" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviewpulse_project_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_project_enables" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_project_enables_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "membership_caches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "membership_caches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commit_caches" (
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "author_email" TEXT,
    "author_email_normalized" TEXT,
    "authored_at" TIMESTAMP(3) NOT NULL,
    "title" TEXT,
    "web_url" TEXT,
    "raw_payload_updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "commit_caches_pkey" PRIMARY KEY ("gitlab_instance_id","gitlab_project_id","sha")
);

CREATE TABLE "merge_request_caches" (
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "iid" INTEGER NOT NULL,
    "title" TEXT,
    "state" TEXT,
    "author_email" TEXT,
    "author_email_normalized" TEXT,
    "head_sha" TEXT,
    "web_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "merge_request_caches_pkey" PRIMARY KEY ("gitlab_instance_id","gitlab_project_id","iid")
);

CREATE TABLE "commit_sync_states" (
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "watermark_authored_at" TIMESTAMP(3),
    "last_full_window_start" TIMESTAMP(3),
    "last_full_window_end" TIMESTAMP(3),
    "last_branch_cursor" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "commit_sync_states_pkey" PRIMARY KEY ("gitlab_instance_id","gitlab_project_id")
);

CREATE TABLE "mr_sync_states" (
    "gitlab_instance_id" TEXT NOT NULL,
    "gitlab_project_id" TEXT NOT NULL,
    "updated_after_cursor" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mr_sync_states_pkey" PRIMARY KEY ("gitlab_instance_id","gitlab_project_id")
);

CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "gitlab_instance_id" TEXT,
    "gitlab_project_id" TEXT,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "meta_json_safe" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "kpi_rule_sets" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "notes_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kpi_rule_sets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "kpi_rules" (
    "id" TEXT NOT NULL,
    "ruleset_id" TEXT NOT NULL,
    "metric_key" TEXT NOT NULL,
    "reference_min" DOUBLE PRECISION,
    "reference_max" DOUBLE PRECISION,
    "unit" TEXT,
    "detection_rule" TEXT,
    "options_json" JSONB NOT NULL DEFAULT '{}',
    "status" "KpiRuleStatus" NOT NULL DEFAULT 'active',
    CONSTRAINT "kpi_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_scope" TEXT NOT NULL,
    "metric_key" TEXT NOT NULL,
    "value_nullable" DOUBLE PRECISION,
    "unit" TEXT,
    "verification_status" TEXT,
    "rule_version" TEXT NOT NULL,
    "source" TEXT,
    "detection_rule" TEXT,
    "calculated_at" TIMESTAMP(3) NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_instance_allowlist_base_url_normalized_key" ON "gitlab_instance_allowlist"("base_url_normalized");
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users"("normalized_email");
CREATE INDEX "user_emails_normalized_email_idx" ON "user_emails"("normalized_email");
CREATE UNIQUE INDEX "user_emails_user_id_normalized_email_key" ON "user_emails"("user_id", "normalized_email");
CREATE INDEX "gitlab_connections_user_id_gitlab_instance_id_status_idx" ON "gitlab_connections"("user_id", "gitlab_instance_id", "status");
CREATE INDEX "gitlab_connections_gitlab_instance_id_gitlab_user_id_status_idx" ON "gitlab_connections"("gitlab_instance_id", "gitlab_user_id", "status");
CREATE INDEX "user_credentials_connection_id_status_idx" ON "user_credentials"("connection_id", "status");

-- Database invariants (partial unique indexes).
-- Prisma schema cannot express WHERE clauses on @@unique; these are the source of truth.
-- One active GitLab connection per ReviewPulse user per instance.
CREATE UNIQUE INDEX "gitlab_connections_one_active_per_user_instance"
  ON "gitlab_connections" ("user_id", "gitlab_instance_id")
  WHERE "status" = 'active';
-- One live GitLab identity binding (active|invalid) — superseded/deleted do not block reuse after cleanup.
CREATE UNIQUE INDEX "gitlab_connections_one_live_identity"
  ON "gitlab_connections" ("gitlab_instance_id", "gitlab_user_id")
  WHERE "status" IN ('active', 'invalid');
-- One active credential per connection; superseded/revoked/invalid do not block a new active row.
CREATE UNIQUE INDEX "user_credentials_one_active_per_connection"
  ON "user_credentials" ("connection_id")
  WHERE "status" = 'active';
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");
CREATE UNIQUE INDEX "reviewpulse_project_allowlist_gitlab_instance_id_gitlab_pro_key" ON "reviewpulse_project_allowlist"("gitlab_instance_id", "gitlab_project_id");
CREATE UNIQUE INDEX "user_project_enables_user_id_gitlab_instance_id_gitlab_proj_key" ON "user_project_enables"("user_id", "gitlab_instance_id", "gitlab_project_id");
CREATE INDEX "membership_caches_expires_at_idx" ON "membership_caches"("expires_at");
CREATE UNIQUE INDEX "membership_caches_user_id_gitlab_instance_id_gitlab_project_key" ON "membership_caches"("user_id", "gitlab_instance_id", "gitlab_project_id");
CREATE INDEX "commit_caches_author_email_normalized_authored_at_idx" ON "commit_caches"("author_email_normalized", "authored_at");
CREATE INDEX "merge_request_caches_author_email_normalized_updated_at_idx" ON "merge_request_caches"("author_email_normalized", "updated_at");
CREATE INDEX "sync_jobs_status_run_after_idx" ON "sync_jobs"("status", "run_after");
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");
CREATE UNIQUE INDEX "kpi_rule_sets_role_version_key" ON "kpi_rule_sets"("role", "version");
CREATE UNIQUE INDEX "kpi_rules_ruleset_id_metric_key_key" ON "kpi_rules"("ruleset_id", "metric_key");
CREATE INDEX "metric_snapshots_user_id_metric_key_window_start_idx" ON "metric_snapshots"("user_id", "metric_key", "window_start");

-- AddForeignKey
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_gitlab_instance_id_fkey" FOREIGN KEY ("gitlab_instance_id") REFERENCES "gitlab_instance_allowlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "gitlab_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviewpulse_project_allowlist" ADD CONSTRAINT "reviewpulse_project_allowlist_gitlab_instance_id_fkey" FOREIGN KEY ("gitlab_instance_id") REFERENCES "gitlab_instance_allowlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_project_enables" ADD CONSTRAINT "user_project_enables_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_caches" ADD CONSTRAINT "membership_caches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "kpi_rules" ADD CONSTRAINT "kpi_rules_ruleset_id_fkey" FOREIGN KEY ("ruleset_id") REFERENCES "kpi_rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
