import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);

const migrationPath = join(migrationsDir, "20260805000000_init/migration.sql");
const wp1MigrationPath = join(
  migrationsDir,
  "20260805120000_wp1_credential_envelope/migration.sql",
);

describe("WP0 baseline migration invariants", () => {
  const sql = readFileSync(migrationPath, "utf8");

  it("does not use a full unique on gitlab identity that would block superseded history", () => {
    assert.equal(
      sql.includes(
        'CREATE UNIQUE INDEX "gitlab_connections_gitlab_instance_id_gitlab_user_id_key"',
      ),
      false,
    );
  });

  it("defines one-active-connection-per-user-instance partial unique", () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "gitlab_connections_one_active_per_user_instance"[\s\S]*WHERE "status" = 'active'/,
    );
  });

  it("defines one-live-identity partial unique for active|invalid", () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "gitlab_connections_one_live_identity"[\s\S]*WHERE "status" IN \('active', 'invalid'\)/,
    );
  });

  it("defines one-active-credential-per-connection partial unique", () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "user_credentials_one_active_per_connection"[\s\S]*WHERE "status" = 'active'/,
    );
  });

  it("migration SQL is non-destructive and has no embedded secrets", () => {
    assert.equal(/\bDROP\b/i.test(sql), false);
    assert.equal(/\bTRUNCATE\b/i.test(sql), false);
    assert.equal(/\bDELETE FROM\b/i.test(sql), false);
    assert.equal(/TOKEN_ENCRYPTION_KEY|SESSION_SECRET|BEGIN PRIVATE/i.test(sql), false);
  });

  it("baseline is untouched by WP1 — no envelope columns added retroactively", () => {
    assert.equal(/auth_tag|envelope_version|invalidation_reason/.test(sql), false);
  });
});

describe("WP1 credential envelope migration invariants", () => {
  const sql = readFileSync(wp1MigrationPath, "utf8");

  it("adds the envelope columns the sealer needs", () => {
    assert.match(
      sql,
      /ALTER TABLE "user_credentials" ADD COLUMN "auth_tag" BYTEA NOT NULL;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "user_credentials" ADD COLUMN "envelope_version" INTEGER NOT NULL DEFAULT 1;/,
    );
    assert.match(
      sql,
      /ALTER TABLE "user_credentials" ADD COLUMN "invalidation_reason" "CredentialInvalidationReason";/,
    );
  });

  it("declares the locked invalidation reason enum", () => {
    assert.match(
      sql,
      /CREATE TYPE "CredentialInvalidationReason" AS ENUM \('gitlab_unauthorized', 'expired', 'user_revoked', 'user_deleted', 'connection_deleted'\);/,
    );
  });

  it("is additive: no drops, rewrites, or plaintext PAT column", () => {
    assert.equal(/\bDROP\b/i.test(sql), false);
    assert.equal(/\bTRUNCATE\b/i.test(sql), false);
    assert.equal(/\bDELETE FROM\b/i.test(sql), false);
    assert.equal(/\bALTER COLUMN\b/i.test(sql), false);
    assert.equal(/\bRENAME\b/i.test(sql), false);
    assert.equal(/\bUPDATE\b\s+"user_credentials"/i.test(sql), false);
    assert.equal(/pat_plaintext|plain_pat|"pat"/i.test(sql), false);
  });

  it("has no embedded secrets", () => {
    assert.equal(
      /TOKEN_ENCRYPTION_KEY|SESSION_SECRET|BEGIN PRIVATE|glpat-/i.test(sql),
      false,
    );
  });
});
