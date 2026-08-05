import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPatAuthAdapter } from "./auth.js";
import { createGitLabReadClient, type GitLabReadClient } from "./client.js";
import {
  GitLabInvalidConfigError,
  GitLabMalformedResponseError,
  GitLabProjectNotFoundError,
  GitLabSsrfBlockedError,
  GitLabUnauthorizedError,
} from "./errors.js";
import { drainPages } from "./pagination.js";
import { createSsrfGuard } from "./ssrf.js";
import {
  createMockTransport,
  createSequenceTransport,
  jsonResponse,
  publicResolver,
  recordingSleep,
  testAuth,
  TEST_ORIGIN,
  TEST_TOKEN,
  type MockResponseSpec,
  type MockTransport,
} from "./test-support.js";
import { createGitLabAllowlist } from "./url.js";

function clientWith(transport: MockTransport): GitLabReadClient {
  return createGitLabReadClient({
    instance: { instanceId: "inst-1", baseUrlNormalized: TEST_ORIGIN },
    auth: testAuth(),
    ssrf: createSsrfGuard({
      allowlist: createGitLabAllowlist([TEST_ORIGIN]),
      resolve: publicResolver(),
    }),
    transport,
    limits: { perPage: 100 },
    sleep: recordingSleep([]),
  });
}

function sequenced(specs: readonly MockResponseSpec[]): {
  client: GitLabReadClient;
  transport: MockTransport;
} {
  const transport = createSequenceTransport(specs);
  return { client: clientWith(transport), transport };
}

function requestUrl(transport: MockTransport, index = 0): URL {
  const request = transport.requests[index];
  assert.ok(request, `expected request #${index + 1}`);
  return new URL(request.url);
}

const USER_PAYLOAD = {
  id: 11,
  username: "alice",
  name: "Alice",
  email: "alice@example.com",
  extra_field_we_ignore: true,
};

const PROJECT_PAYLOAD = {
  id: 5,
  name: "proj",
  path_with_namespace: "group/proj",
  archived: false,
  default_branch: "main",
  web_url: "https://gitlab.example.com/group/proj",
  last_activity_at: "2026-08-01T10:00:00.000Z",
};

describe("getCurrentUser", () => {
  it("calls /api/v4/user and maps the payload", async () => {
    const { client, transport } = sequenced([jsonResponse(USER_PAYLOAD)]);
    const user = await client.getCurrentUser();

    assert.equal(requestUrl(transport).pathname, "/api/v4/user");
    assert.deepEqual(user, {
      id: 11,
      username: "alice",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("maps a 401 to unauthorized without touching credentials", async () => {
    const { client } = sequenced([{ status: 401, body: "{}" }]);
    await assert.rejects(
      () => client.getCurrentUser(),
      GitLabUnauthorizedError,
    );
  });

  it("treats a missing username as a malformed response", async () => {
    const { client } = sequenced([jsonResponse({ id: 11 })]);
    await assert.rejects(
      () => client.getCurrentUser(),
      GitLabMalformedResponseError,
    );
  });
});

describe("listAccessibleProjects", () => {
  it("requests membership projects with pagination params", async () => {
    const { client, transport } = sequenced([
      jsonResponse([PROJECT_PAYLOAD], { "x-next-page": "" }),
    ]);
    const page = await client.listAccessibleProjects();
    const url = requestUrl(transport);

    assert.equal(url.pathname, "/api/v4/projects");
    assert.equal(url.searchParams.get("membership"), "true");
    assert.equal(url.searchParams.get("simple"), "true");
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.pathWithNamespace, "group/proj");
    assert.equal(page.nextPage, null);
  });

  it("follows Link rel=next across pages", async () => {
    const { client, transport } = sequenced([
      jsonResponse([PROJECT_PAYLOAD], {
        link: `<${TEST_ORIGIN}/api/v4/projects?page=2&per_page=100>; rel="next"`,
      }),
      jsonResponse([{ ...PROJECT_PAYLOAD, id: 6 }]),
    ]);

    const first = await client.listAccessibleProjects();
    assert.deepEqual(first.nextPage, { page: 2, perPage: 100 });
    assert.ok(first.nextPage);

    const second = await client.listAccessibleProjects({
      page: first.nextPage,
    });
    assert.equal(requestUrl(transport, 1).searchParams.get("page"), "2");
    assert.equal(second.nextPage, null);
    assert.equal(second.items[0]?.id, 6);
  });

  it("follows X-Next-Page when Link is absent", async () => {
    const { client } = sequenced([
      jsonResponse([PROJECT_PAYLOAD], { "x-next-page": "3", "x-per-page": "20" }),
    ]);
    const page = await client.listAccessibleProjects();
    assert.deepEqual(page.nextPage, { page: 3, perPage: 20 });
  });

  it("refuses a next link pointing at another origin", async () => {
    const { client } = sequenced([
      jsonResponse([PROJECT_PAYLOAD], {
        link: `<https://evil.example.com/api/v4/projects?page=2>; rel="next"`,
      }),
    ]);
    await assert.rejects(
      () => client.listAccessibleProjects(),
      GitLabSsrfBlockedError,
    );
  });

  it("drains every page through drainPages", async () => {
    const { client } = sequenced([
      jsonResponse([PROJECT_PAYLOAD], { "x-next-page": "2" }),
      jsonResponse([{ ...PROJECT_PAYLOAD, id: 6 }], { "x-next-page": "3" }),
      jsonResponse([{ ...PROJECT_PAYLOAD, id: 7 }], { "x-next-page": "" }),
    ]);

    const all = await drainPages(
      (cursor) => client.listAccessibleProjects({ page: cursor }),
      { perPage: 100, maxPages: 10, maxItems: 100 },
    );
    assert.deepEqual(
      all.map((project) => project.id),
      [5, 6, 7],
    );
  });

  it("rejects a non-array list payload", async () => {
    const { client } = sequenced([jsonResponse({ items: [] })]);
    await assert.rejects(
      () => client.listAccessibleProjects(),
      GitLabMalformedResponseError,
    );
  });
});

describe("getProject", () => {
  it("URL-encodes a namespace path", async () => {
    const { client, transport } = sequenced([jsonResponse(PROJECT_PAYLOAD)]);
    await client.getProject("group/sub/proj");

    assert.equal(
      requestUrl(transport).pathname,
      "/api/v4/projects/group%2Fsub%2Fproj",
    );
  });

  it("maps a project 404 to the project-scoped error", async () => {
    const { client } = sequenced([{ status: 404, body: "{}" }]);
    await assert.rejects(
      () => client.getProject(5),
      GitLabProjectNotFoundError,
    );
  });
});

describe("listBranches", () => {
  it("hits the repository branches endpoint", async () => {
    const { client, transport } = sequenced([
      jsonResponse([
        { name: "main", merged: false, protected: true, default: true },
      ]),
    ]);
    const page = await client.listBranches(5);

    assert.equal(
      requestUrl(transport).pathname,
      "/api/v4/projects/5/repository/branches",
    );
    assert.deepEqual(page.items[0], {
      name: "main",
      merged: false,
      protected: true,
      default: true,
    });
  });
});

describe("listCommits", () => {
  const since = new Date("2026-08-01T00:00:00.000Z");
  const until = new Date("2026-08-05T00:00:00.000Z");

  const commitPayload = {
    id: "a".repeat(40),
    short_id: "aaaaaaa",
    title: "Fix thing",
    message: "Fix thing\n",
    author_name: "Alice",
    author_email: "alice@example.com",
    authored_date: "2026-08-02T09:00:00.000Z",
    web_url: "https://gitlab.example.com/group/proj/-/commit/aaa",
  };

  it("filters on since/until and never on updated_after", async () => {
    const { client, transport } = sequenced([jsonResponse([commitPayload])]);
    await client.listCommits(5, { since, until, refName: "main" });

    const url = requestUrl(transport);
    assert.equal(url.pathname, "/api/v4/projects/5/repository/commits");
    assert.equal(url.searchParams.get("since"), since.toISOString());
    assert.equal(url.searchParams.get("until"), until.toISOString());
    assert.equal(url.searchParams.get("ref_name"), "main");
    assert.equal(url.searchParams.has("updated_after"), false);
  });

  it("omits ref_name when the caller does not scope to a branch", async () => {
    const { client, transport } = sequenced([jsonResponse([commitPayload])]);
    await client.listCommits(5, { since, until });
    assert.equal(requestUrl(transport).searchParams.has("ref_name"), false);
  });

  it("maps commit fields and rejects one with no SHA", async () => {
    const ok = sequenced([jsonResponse([commitPayload])]);
    const page = await ok.client.listCommits(5, { since, until });
    assert.equal(page.items[0]?.id, "a".repeat(40));
    assert.equal(page.items[0]?.authoredDate, "2026-08-02T09:00:00.000Z");

    const bad = sequenced([
      jsonResponse([{ ...commitPayload, id: undefined }]),
    ]);
    await assert.rejects(
      () => bad.client.listCommits(5, { since, until }),
      GitLabMalformedResponseError,
    );
  });

  it("rejects an invalid date instead of sending 'Invalid Date'", async () => {
    const { client } = sequenced([jsonResponse([])]);
    await assert.rejects(
      () => client.listCommits(5, { since: new Date("nope"), until }),
      GitLabInvalidConfigError,
    );
  });
});

describe("listMergeRequests", () => {
  const updatedAfter = new Date("2026-08-01T00:00:00.000Z");

  const mrPayload = {
    iid: 3,
    project_id: 5,
    title: "Add feature",
    state: "opened",
    author: { username: "alice" },
    updated_at: "2026-08-04T12:00:00.000Z",
    web_url: "https://gitlab.example.com/group/proj/-/merge_requests/3",
    sha: "b".repeat(40),
  };

  it("filters on updated_after and never on since/until", async () => {
    const { client, transport } = sequenced([jsonResponse([mrPayload])]);
    await client.listMergeRequests(5, { updatedAfter, state: "all" });

    const url = requestUrl(transport);
    assert.equal(url.pathname, "/api/v4/projects/5/merge_requests");
    assert.equal(
      url.searchParams.get("updated_after"),
      updatedAfter.toISOString(),
    );
    assert.equal(url.searchParams.get("state"), "all");
    assert.equal(url.searchParams.has("since"), false);
    assert.equal(url.searchParams.has("until"), false);
  });

  it("maps the author and tolerates a missing email", async () => {
    const { client } = sequenced([jsonResponse([mrPayload])]);
    const page = await client.listMergeRequests(5, { updatedAfter });

    assert.equal(page.items[0]?.authorUsername, "alice");
    assert.equal(page.items[0]?.authorEmail, null);
    assert.equal(page.items[0]?.sha, "b".repeat(40));
  });
});

describe("client construction", () => {
  it("rejects a missing base URL", () => {
    assert.throws(
      () =>
        createGitLabReadClient({
          instance: { instanceId: "x", baseUrlNormalized: "" },
          auth: testAuth(),
        }),
      GitLabInvalidConfigError,
    );
  });

  it("blocks a request when the instance origin is not allowlisted", async () => {
    const transport = createMockTransport(() => jsonResponse(USER_PAYLOAD));
    const client = createGitLabReadClient({
      instance: {
        instanceId: "x",
        baseUrlNormalized: "https://gitlab.example.com",
      },
      auth: testAuth(),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist(["https://other.example.com"]),
        resolve: publicResolver(),
      }),
      transport,
    });

    await assert.rejects(() => client.getCurrentUser(), GitLabSsrfBlockedError);
    assert.equal(transport.requests.length, 0);
  });

  it("rejects a blank token from the auth adapter before sending anything", async () => {
    const transport = createMockTransport(() => jsonResponse(USER_PAYLOAD));
    const client = createGitLabReadClient({
      instance: { instanceId: "x", baseUrlNormalized: TEST_ORIGIN },
      auth: createPatAuthAdapter(() => ""),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist([TEST_ORIGIN]),
        resolve: publicResolver(),
      }),
      transport,
    });

    await assert.rejects(
      () => client.getCurrentUser(),
      GitLabInvalidConfigError,
    );
    assert.equal(transport.requests.length, 0);
  });

  it("reads the token per request rather than caching it", async () => {
    const tokens = ["glpat-first", "glpat-second"];
    const transport = createMockTransport(() => jsonResponse(USER_PAYLOAD));
    const client = createGitLabReadClient({
      instance: { instanceId: "x", baseUrlNormalized: TEST_ORIGIN },
      auth: createPatAuthAdapter(() => tokens.shift() ?? "glpat-exhausted"),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist([TEST_ORIGIN]),
        resolve: publicResolver(),
      }),
      transport,
    });

    await client.getCurrentUser();
    await client.getCurrentUser();

    assert.equal(transport.requests[0]?.headers["private-token"], "glpat-first");
    assert.equal(
      transport.requests[1]?.headers["private-token"],
      "glpat-second",
    );
  });

  it("never places the token in a request URL", async () => {
    const transport = createMockTransport((request) =>
      new URL(request.url).pathname === "/api/v4/projects"
        ? jsonResponse([PROJECT_PAYLOAD])
        : jsonResponse(
            request.url.includes("/projects/") ? PROJECT_PAYLOAD : USER_PAYLOAD,
          ),
    );
    const client = clientWith(transport);

    await client.getCurrentUser();
    await client.listAccessibleProjects();
    await client.getProject("group/proj");

    for (const request of transport.requests) {
      assert.equal(request.url.includes(TEST_TOKEN), false);
      assert.equal(request.url.toLowerCase().includes("token"), false);
    }
  });
});
