import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  integrationDatabaseUrlIssue,
  requirePostgresIntegrationDatabase,
} from "./integration-test-setup.js";

describe("PostgreSQL integration test setup", () => {
  it("rejects a missing DATABASE_URL", () => {
    assert.equal(
      integrationDatabaseUrlIssue({}),
      "DATABASE_URL is required",
    );
  });

  it("rejects a non-PostgreSQL DATABASE_URL without exposing its value", () => {
    const secret = "mysql://user:password@example.test/db";
    const issue = integrationDatabaseUrlIssue({ DATABASE_URL: secret });
    assert.match(issue ?? "", /must start with postgresql/);
    assert.equal(issue?.includes(secret), false);
  });

  it("accepts PostgreSQL URL schemes", () => {
    assert.equal(
      integrationDatabaseUrlIssue({
        DATABASE_URL: "postgresql://example.invalid/db",
      }),
      null,
    );
    assert.equal(
      integrationDatabaseUrlIssue({
        DATABASE_URL: "postgres://example.invalid/db",
      }),
      null,
    );
  });

  it("fails clearly when PostgreSQL cannot be reached", async () => {
    await assert.rejects(
      requirePostgresIntegrationDatabase("Example suite", {
        env: { DATABASE_URL: "postgresql://example.invalid/db" },
        prisma: {
          $queryRaw: async () => {
            throw new Error("password=must-not-leak");
          },
        },
      }),
      (error: unknown) => {
        assert.match(String(error), /Example suite: PostgreSQL is not reachable/);
        assert.equal(String(error).includes("must-not-leak"), false);
        return true;
      },
    );
  });
});
