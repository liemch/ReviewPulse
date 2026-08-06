import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ConnectionPolicyError } from "./gitlab-connection.js";
import { LiveProjectAccessService } from "./project-access.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("WP4 enable ACL", () => {
  it("rejects enable when project is not allowlisted", async () => {
    const prisma = {
      reviewPulseProjectAllowlist: {
        findUnique: async () => null,
      },
    };
    const service = new LiveProjectAccessService(prisma as never, {} as never);
    await assert.rejects(
      () =>
        service.enable({
          userId: "user-a",
          gitlabInstanceId: "inst-1",
          gitlabProjectId: "42",
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /allowlist/i.test(error.message),
    );
  });

  it("rejects enable when user has no active connection", async () => {
    const prisma = {
      reviewPulseProjectAllowlist: {
        findUnique: async () => ({
          gitlabInstanceId: "inst-1",
          gitlabProjectId: "42",
        }),
      },
      gitLabConnection: {
        findFirst: async () => null,
      },
    };
    const service = new LiveProjectAccessService(prisma as never, {} as never);
    await assert.rejects(
      () =>
        service.enable({
          userId: "user-a",
          gitlabInstanceId: "inst-1",
          gitlabProjectId: "42",
        }),
      (error: unknown) =>
        error instanceof ConnectionPolicyError &&
        /connection/i.test(error.message),
    );
  });
});

describe("GitLab connection IDOR surface", () => {
  it("delete scopes by caller userId", () => {
    const source = readFileSync(
      join(ROOT, "packages/domain/src/gitlab-connection.ts"),
      "utf8",
    );
    assert.match(
      source,
      /findFirst\(\{\s*where:\s*\{\s*id:\s*input\.connectionId,\s*userId:\s*input\.userId/s,
    );
  });

  it("listForUser filters by userId", () => {
    const source = readFileSync(
      join(ROOT, "packages/domain/src/gitlab-connection.ts"),
      "utf8",
    );
    assert.match(source, /where:\s*\{\s*userId,/);
  });
});

describe("no GitLab mutation helpers in domain", () => {
  it("does not call mutation HTTP verbs", () => {
    const dir = join(ROOT, "packages/domain/src");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, name), "utf8");
      assert.equal(/\bmethod:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(source), false);
    }
  });
});
