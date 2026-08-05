import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitLabSsrfBlockedError } from "./errors.js";
import { createSsrfGuard } from "./ssrf.js";
import { PUBLIC_ADDRESS, staticResolver } from "./test-support.js";
import { createGitLabAllowlist } from "./url.js";

const EXTERNAL = "https://gitlab.example.com";
const INTERNAL = "https://gitlab.corp.example";

function guardFor(
  answers: Readonly<Record<string, ReadonlyArray<{ address: string; family: 4 | 6 }>>>,
) {
  return createSsrfGuard({
    allowlist: createGitLabAllowlist([
      EXTERNAL,
      { url: INTERNAL, internal: true },
    ]),
    resolve: staticResolver(answers),
  });
}

describe("SSRF guard — allowlist", () => {
  it("allows an allowlisted host resolving to public unicast", async () => {
    const guard = guardFor({
      "gitlab.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    const decision = await guard.check(new URL(`${EXTERNAL}/api/v4/user`));

    assert.equal(decision.origin, EXTERNAL);
    assert.equal(decision.hostname, "gitlab.example.com");
    assert.equal(decision.port, 443);
    assert.equal(decision.pinnedAddress, PUBLIC_ADDRESS);
    assert.equal(decision.pinnedFamily, 4);
  });

  it("blocks a host that is not on the allowlist", async () => {
    const guard = guardFor({
      "evil.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    await assert.rejects(
      () => guard.check(new URL("https://evil.example.com/api/v4/user")),
      GitLabSsrfBlockedError,
    );
  });

  it("blocks a subdomain of an allowlisted host", async () => {
    const guard = guardFor({
      "evil.gitlab.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    await assert.rejects(
      () => guard.check(new URL("https://evil.gitlab.example.com/api/v4/user")),
      GitLabSsrfBlockedError,
    );
  });

  it("blocks a scheme downgrade and userinfo smuggling", async () => {
    const guard = guardFor({
      "gitlab.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    await assert.rejects(
      () => guard.check(new URL("http://gitlab.example.com/api/v4/user")),
      GitLabSsrfBlockedError,
    );
    await assert.rejects(
      () =>
        guard.check(new URL("https://user:pw@gitlab.example.com/api/v4/user")),
      GitLabSsrfBlockedError,
    );
  });
});

describe("SSRF guard — address policy", () => {
  it("allows RFC1918 only for an internal-marked origin", async () => {
    const guard = guardFor({
      "gitlab.corp.example": [{ address: "10.20.30.40", family: 4 }],
    });
    const decision = await guard.check(new URL(`${INTERNAL}/api/v4/user`));
    assert.equal(decision.pinnedAddress, "10.20.30.40");
  });

  it("blocks RFC1918 for an allowlisted but external origin", async () => {
    const guard = guardFor({
      "gitlab.example.com": [{ address: "10.20.30.40", family: 4 }],
    });
    await assert.rejects(
      () => guard.check(new URL(`${EXTERNAL}/api/v4/user`)),
      (error: unknown) => {
        assert.ok(error instanceof GitLabSsrfBlockedError);
        assert.equal(
          error.context["reason"],
          "private_address_not_permitted",
        );
        return true;
      },
    );
  });

  it("blocks loopback, link-local, and metadata even for an internal origin", async () => {
    const denied = [
      "127.0.0.1",
      "169.254.169.254",
      "169.254.1.1",
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "0.0.0.0",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ];

    for (const address of denied) {
      const guard = guardFor({
        "gitlab.corp.example": [
          { address, family: address.includes(":") ? 6 : 4 },
        ],
      });
      await assert.rejects(
        () => guard.check(new URL(`${INTERNAL}/api/v4/user`)),
        GitLabSsrfBlockedError,
        address,
      );
    }
  });

  it("blocks an unparseable DNS answer instead of passing it to the stack", async () => {
    const guard = guardFor({
      "gitlab.corp.example": [{ address: "not-an-ip", family: 4 }],
    });
    await assert.rejects(
      () => guard.check(new URL(`${INTERNAL}/api/v4/user`)),
      GitLabSsrfBlockedError,
    );
  });
});

describe("SSRF guard — DNS handling", () => {
  it("fails closed when any answer is denied, not just the first", async () => {
    const guard = guardFor({
      "gitlab.example.com": [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    await assert.rejects(
      () => guard.check(new URL(`${EXTERNAL}/api/v4/user`)),
      GitLabSsrfBlockedError,
    );
  });

  it("fails closed on an empty answer", async () => {
    const guard = guardFor({ "gitlab.example.com": [] });
    await assert.rejects(
      () => guard.check(new URL(`${EXTERNAL}/api/v4/user`)),
      GitLabSsrfBlockedError,
    );
  });

  it("fails closed on resolver failure without echoing the resolver error", async () => {
    const guard = createSsrfGuard({
      allowlist: createGitLabAllowlist([EXTERNAL]),
      resolve: async () => {
        throw new Error("getaddrinfo ENOTFOUND gitlab.example.com");
      },
    });
    await assert.rejects(
      () => guard.check(new URL(`${EXTERNAL}/api/v4/user`)),
      (error: unknown) => {
        assert.ok(error instanceof GitLabSsrfBlockedError);
        assert.equal(error.message, "Request blocked by GitLab egress policy");
        assert.equal(error.context["reason"], "dns_failure");
        return true;
      },
    );
  });

  it("classifies an IP-literal host without consulting DNS", async () => {
    let resolverCalls = 0;
    const guard = createSsrfGuard({
      allowlist: createGitLabAllowlist([{ url: "https://10.1.2.3", internal: true }]),
      resolve: async () => {
        resolverCalls += 1;
        return [];
      },
    });

    const decision = await guard.check(new URL("https://10.1.2.3/api/v4/user"));
    assert.equal(decision.pinnedAddress, "10.1.2.3");
    assert.equal(resolverCalls, 0);
  });

  it("blocks a loopback IP literal even when it is allowlisted", async () => {
    const guard = createSsrfGuard({
      allowlist: createGitLabAllowlist([
        { url: "https://127.0.0.1:8443", internal: true },
      ]),
      resolve: staticResolver({}),
    });
    await assert.rejects(
      () => guard.check(new URL("https://127.0.0.1:8443/api/v4/user")),
      GitLabSsrfBlockedError,
    );
  });
});

describe("SSRF guard — same origin", () => {
  it("accepts the instance origin and rejects anything else", () => {
    const guard = guardFor({});
    guard.assertSameOrigin(new URL(`${EXTERNAL}/api/v4/user?page=2`), EXTERNAL);

    assert.throws(
      () =>
        guard.assertSameOrigin(
          new URL("https://evil.example.com/api/v4/user"),
          EXTERNAL,
        ),
      GitLabSsrfBlockedError,
    );
  });
});
