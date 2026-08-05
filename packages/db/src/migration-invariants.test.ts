import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations/20260805000000_init/migration.sql",
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
});
