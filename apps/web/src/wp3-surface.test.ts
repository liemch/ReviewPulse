import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_SRC = join(ROOT, "apps/web/src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("wp3/wp4 security surface", () => {
  it("does not expose a public signup route", () => {
    const names = readdirSync(join(WEB_SRC, "app"));
    assert.equal(names.includes("signup"), false);
    assert.equal(names.includes("register"), false);
  });

  it("login page states invite-only and has no signup link", () => {
    const source = readFileSync(join(WEB_SRC, "app/login/page.tsx"), "utf8");
    assert.match(source, /invite-only/i);
    assert.equal(/href=["']\/signup["']/.test(source), false);
  });

  it("bootstrap admin is CLI-only", () => {
    const source = readFileSync(
      join(ROOT, "apps/web/scripts/bootstrap-admin.ts"),
      "utf8",
    );
    assert.match(source, /CLI only/i);
  });

  it("mutating settings routes require CSRF + Origin", () => {
    for (const rel of [
      "app/api/settings/gitlab/route.ts",
      "app/api/settings/projects/route.ts",
      "app/api/admin/users/route.ts",
      "app/api/admin/allowlist/route.ts",
      "app/api/auth/login/route.ts",
      "app/api/auth/logout/route.ts",
      "app/api/auth/sessions/revoke-all/route.ts",
    ]) {
      const source = readFileSync(join(WEB_SRC, rel), "utf8");
      assert.match(source, /assertCsrf/);
      assert.match(source, /assertOrigin/);
    }
  });

  it("GitLab settings UI never re-prints a full PAT", () => {
    const source = readFileSync(
      join(WEB_SRC, "app/settings/gitlab/page.tsx"),
      "utf8",
    );
    assert.match(source, /never shown again/i);
    assert.equal(/connection\.pat\b/.test(source), false);
    assert.match(source, /patHintLast4/);
  });

  it("web sources do not introduce GitLab write verbs", () => {
    for (const file of walk(WEB_SRC)) {
      const source = readFileSync(file, "utf8");
      assert.equal(
        /\bmethod:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(source),
        false,
        file,
      );
    }
  });
});
