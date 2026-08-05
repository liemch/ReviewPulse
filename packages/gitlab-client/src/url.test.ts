import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitLabInvalidConfigError } from "./errors.js";
import {
  buildApiUrl,
  createGitLabAllowlist,
  encodeProjectId,
  normalizeGitLabBaseUrl,
  originOf,
  parseAllowlistEnv,
} from "./url.js";

describe("normalizeGitLabBaseUrl", () => {
  it("canonicalizes case, default port, and trailing slash to one origin", () => {
    const variants = [
      "https://gitlab.example.com",
      "https://GitLab.Example.com",
      "https://gitlab.example.com/",
      "https://gitlab.example.com:443",
      "  https://gitlab.example.com/  ",
    ];
    for (const variant of variants) {
      assert.equal(
        normalizeGitLabBaseUrl(variant),
        "https://gitlab.example.com",
        variant,
      );
    }
  });

  it("keeps an explicit non-default port", () => {
    assert.equal(
      normalizeGitLabBaseUrl("https://gitlab.example.com:8443/"),
      "https://gitlab.example.com:8443",
    );
  });

  it("rejects inputs that would widen or redirect the target", () => {
    const rejected = [
      "",
      "   ",
      "gitlab.example.com",
      "ftp://gitlab.example.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pass@gitlab.example.com",
      "https://gitlab.example.com/gitlab",
      "https://gitlab.example.com/?x=1",
      "https://gitlab.example.com/#frag",
      "https://",
    ];
    for (const input of rejected) {
      assert.throws(
        () => normalizeGitLabBaseUrl(input),
        GitLabInvalidConfigError,
        input,
      );
    }
  });

  it("requires https unless explicitly relaxed", () => {
    assert.throws(
      () => normalizeGitLabBaseUrl("http://gitlab.example.com"),
      GitLabInvalidConfigError,
    );
    assert.equal(
      normalizeGitLabBaseUrl("http://gitlab.example.com", {
        requireHttps: false,
      }),
      "http://gitlab.example.com",
    );
  });
});

describe("allowlist matching", () => {
  it("matches exactly and never by domain suffix", () => {
    const allowlist = createGitLabAllowlist(["https://gitlab.example.com"]);

    assert.notEqual(allowlist.find("https://gitlab.example.com"), null);
    assert.equal(allowlist.find("https://evil.gitlab.example.com"), null);
    assert.equal(allowlist.find("https://gitlab.example.com.evil.test"), null);
    assert.equal(allowlist.find("http://gitlab.example.com"), null);
    assert.equal(allowlist.find("https://gitlab.example.com:8443"), null);
  });

  it("normalizes entries so a sloppy config still matches", () => {
    const allowlist = createGitLabAllowlist(["HTTPS://GitLab.Example.com:443/"]);
    assert.notEqual(allowlist.find("https://gitlab.example.com"), null);
  });

  it("defaults entries to external and honors the internal opt-in", () => {
    const allowlist = createGitLabAllowlist([
      "https://gitlab.example.com",
      { url: "https://gitlab.corp.example", internal: true },
    ]);
    assert.equal(allowlist.find("https://gitlab.example.com")?.internal, false);
    assert.equal(allowlist.find("https://gitlab.corp.example")?.internal, true);
  });

  it("parses the env format including the internal: prefix", () => {
    const allowlist = parseAllowlistEnv(
      "https://gitlab.example.com, internal:https://gitlab.corp.example",
    );
    assert.equal(allowlist.entries.length, 2);
    assert.equal(allowlist.find("https://gitlab.example.com")?.internal, false);
    assert.equal(allowlist.find("https://gitlab.corp.example")?.internal, true);
  });

  it("treats an empty env value as an empty allowlist", () => {
    assert.equal(parseAllowlistEnv(undefined).entries.length, 0);
    assert.equal(parseAllowlistEnv("   ").entries.length, 0);
  });

  it("widens rather than drops when an origin is listed twice", () => {
    const allowlist = parseAllowlistEnv(
      "https://gitlab.corp.example internal:https://gitlab.corp.example",
    );
    assert.equal(allowlist.entries.length, 1);
    assert.equal(allowlist.find("https://gitlab.corp.example")?.internal, true);
  });
});

describe("buildApiUrl", () => {
  it("joins the path and encodes query values", () => {
    const url = buildApiUrl("https://gitlab.example.com", "/api/v4/projects", {
      membership: true,
      per_page: 100,
      order_by: "last_activity_at",
    });
    assert.equal(
      url.toString(),
      "https://gitlab.example.com/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at",
    );
  });

  it("omits undefined query values instead of sending the string 'undefined'", () => {
    const url = buildApiUrl("https://gitlab.example.com", "/api/v4/projects", {
      ref_name: undefined,
      page: 1,
    });
    assert.equal(url.searchParams.has("ref_name"), false);
    assert.equal(url.searchParams.get("page"), "1");
  });

  it("preserves a URL-encoded project path", () => {
    const url = buildApiUrl(
      "https://gitlab.example.com",
      `/api/v4/projects/${encodeProjectId("group/sub/proj")}`,
    );
    assert.equal(
      url.pathname,
      "/api/v4/projects/group%2Fsub%2Fproj",
    );
  });

  it("refuses paths that try to escape the instance origin", () => {
    const attacks = [
      "//evil.example.com/api/v4/user",
      "/api/v4//evil.example.com",
      "/api/v4/\\evil.example.com",
      "/api/v4/user@evil.example.com",
      "/oauth/token",
      "/api/v5/user",
    ];
    for (const path of attacks) {
      assert.throws(
        () => buildApiUrl("https://gitlab.example.com", path),
        GitLabInvalidConfigError,
        path,
      );
    }
  });
});

describe("encodeProjectId", () => {
  it("accepts positive integers and namespace paths", () => {
    assert.equal(encodeProjectId(42), "42");
    assert.equal(encodeProjectId("group/proj"), "group%2Fproj");
  });

  it("rejects ids that are not addressable", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "", "   "]) {
      assert.throws(
        () => encodeProjectId(bad as number | string),
        GitLabInvalidConfigError,
        String(bad),
      );
    }
  });
});

describe("originOf", () => {
  it("drops default ports and lowercases the host", () => {
    assert.equal(
      originOf(new URL("https://GitLab.Example.com:443/api/v4/user?x=1")),
      "https://gitlab.example.com",
    );
    assert.equal(
      originOf(new URL("https://gitlab.example.com:8443/api/v4/user")),
      "https://gitlab.example.com:8443",
    );
  });
});
