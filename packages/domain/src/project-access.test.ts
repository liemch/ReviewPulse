import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitLabProjectForbiddenError,
  GitLabProjectNotFoundError,
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

    const visible = await probeAllowlistedProjectIds(client, ["101", "102"]);

    assert.deepEqual(calls.sort(), ["101", "102"]);
    assert.equal(visible.size, 1);
    assert.equal(visible.get("101")?.pathWithNamespace, "group/visible");
    assert.equal(visible.has("102"), false);
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

    const visible = await probeAllowlistedProjectIds(client, ["201", "202"]);

    assert.equal(visible.has("201"), false);
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

  it("fails closed on upstream/network errors", async () => {
    const client = {
      async getProject() {
        throw new GitLabUpstreamUnavailableError({ status: 503 });
      },
    };

    await assert.rejects(
      () => probeAllowlistedProjectIds(client, ["401"]),
      GitLabUpstreamUnavailableError,
    );
  });
});
