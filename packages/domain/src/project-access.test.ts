import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
  GitLabRateLimitedError,
  GitLabUnauthorizedError,
  GitLabUpstreamUnavailableError,
  type GitLabProjectRef,
} from "@reviewpulse/gitlab-client";

import { probeAllowlistedProjectIds } from "./project-access.js";

function projectRef(
  id: number,
  pathWithNamespace: string,
): GitLabProjectRef {
  return {
    id,
    pathWithNamespace,
    name: pathWithNamespace.split("/").at(-1) ?? pathWithNamespace,
    archived: false,
    defaultBranch: "main",
    webUrl: `https://gitlab.example.com/${pathWithNamespace}`,
    lastActivityAt: null,
  };
}

describe("probeAllowlistedProjectIds", () => {
  it("returns visible projects for 200 responses only", async () => {
    const calls: string[] = [];
    const client = {
      async getProject(projectId: number | string) {
        calls.push(String(projectId));
        if (projectId === "101") {
          return projectRef(101, "group/visible");
        }
        throw new GitLabProjectNotFoundError({ status: 404 });
      },
    };

    const { visible, failed } = await probeAllowlistedProjectIds(client, [
      "101",
      "102",
    ]);

    assert.deepEqual(calls.sort(), ["101", "102"]);
    assert.equal(visible.size, 1);
    assert.equal(visible.get("101")?.pathWithNamespace, "group/visible");
    assert.equal(visible.has("102"), false);
    assert.equal(failed.size, 0);
  });

  it("treats 403 as not visible without failing the batch", async () => {
    const client = {
      async getProject(projectId: number | string) {
        if (projectId === "201") {
          throw new GitLabProjectForbiddenError({ status: 403 });
        }
        return projectRef(202, "group/open");
      },
    };

    const { visible, failed } = await probeAllowlistedProjectIds(client, [
      "201",
      "202",
    ]);

    assert.equal(visible.has("201"), false);
    assert.equal(failed.has("201"), false);
    assert.equal(visible.get("202")?.pathWithNamespace, "group/open");
  });

  it("fails closed on 401 for the whole probe", async () => {
    const client = {
      async getProject() {
        throw new GitLabUnauthorizedError({ status: 401 });
      },
    };

    await assert.rejects(
      () => probeAllowlistedProjectIds(client, ["301"]),
      GitLabUnauthorizedError,
    );
  });

  it("reports upstream/network errors per project instead of denying them", async () => {
    const client = {
      async getProject() {
        throw new GitLabUpstreamUnavailableError({ status: 503 });
      },
    };

    const { visible, failed } = await probeAllowlistedProjectIds(client, [
      "401",
    ]);

    assert.equal(visible.size, 0);
    assert.equal(failed.get("401"), "GITLAB_UPSTREAM_UNAVAILABLE");
  });

  it("keeps healthy projects when a sibling probe fails transiently", async () => {
    const client = {
      async getProject(projectId: number | string) {
        if (projectId === "402") {
          throw new GitLabRateLimitedError(null, { status: 429 });
        }
        return projectRef(403, "group/healthy");
      },
    };

    const { visible, failed } = await probeAllowlistedProjectIds(client, [
      "402",
      "403",
    ]);

    assert.equal(failed.get("402"), "GITLAB_RATE_LIMITED");
    assert.equal(visible.get("403")?.pathWithNamespace, "group/healthy");
  });

  it("rethrows non-GitLab errors instead of hiding them as probe failures", async () => {
    const client = {
      async getProject(): Promise<never> {
        throw new TypeError("bug in the caller");
      },
    };

    await assert.rejects(
      () => probeAllowlistedProjectIds(client, ["404"]),
      TypeError,
    );
  });

  it("issues one getProject call per allowlisted id", async () => {
    let callCount = 0;
    const client = {
      async getProject(projectId: number | string) {
        callCount += 1;
        return projectRef(Number(projectId), `group/p-${projectId}`);
      },
    };

    await probeAllowlistedProjectIds(client, ["1", "2", "3"]);

    assert.equal(callCount, 3);
  });

  it("does not call GitLab when the allowlist id set is empty", async () => {
    let callCount = 0;
    const client = {
      async getProject() {
        callCount += 1;
        return projectRef(1, "group/x");
      },
    };

    const { visible } = await probeAllowlistedProjectIds(client, []);

    assert.equal(callCount, 0);
    assert.equal(visible.size, 0);
  });

  it("limits concurrent getProject calls to five", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      async getProject(projectId: number | string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return projectRef(Number(projectId), `group/p-${projectId}`);
      },
    };

    await probeAllowlistedProjectIds(
      client,
      ["1", "2", "3", "4", "5", "6", "7", "8"],
    );

    assert.equal(maxInFlight, 5);
  });
});

describe("createAllowlistedProjectProbe default wiring", () => {
  it("does not expose listAccessibleProjects on the probe path", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./project-access.ts", import.meta.url), "utf8"),
    );
    assert.equal(source.includes("listAccessibleProjects"), false);
    assert.equal(source.includes("drainPages"), false);
  });
});
