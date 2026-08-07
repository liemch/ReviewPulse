/**
 * M2 mutation service — confirm cancel, stale SHA, authz denial (mocked).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MrMutationService } from "./mr-mutations.js";

describe("MrMutationService confirm / stale gates", () => {
  it("approve without confirmed does not call GitLab or write success audit", async () => {
    const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
    const calls: string[] = [];

    const service = Object.create(MrMutationService.prototype) as MrMutationService;
    Object.assign(service, {
      workspace: {
        async getDetail() {
          calls.push("getDetail");
          return {
            gitlabInstanceId: "inst",
            gitlabProjectId: "1",
            pathWithNamespace: "g/p",
            mr: { sha: "aaa", state: "opened" },
            approvals: null,
            pipelines: [],
            diffs: [],
            reviewedHeadSha: "aaa",
          };
        },
      },
      audit: {
        async write(action: string, _actor: string | null, meta: Record<string, unknown>) {
          audits.push({ action, meta });
        },
      },
      async actingWriteClient() {
        calls.push("write");
        throw new Error("should not create write client");
      },
    });

    const result = await MrMutationService.prototype.approve.call(service, "user-a", {
      gitlabInstanceId: "inst",
      gitlabProjectId: "1",
      iid: 1,
    }, {
      reviewedHeadSha: "aaa",
      confirmed: false,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "not_confirmed");
    }
    assert.deepEqual(calls, []);
    assert.equal(audits.length, 0);
  });

  it("merge without confirmed does not call GitLab", async () => {
    const calls: string[] = [];
    const service = Object.create(MrMutationService.prototype) as MrMutationService;
    Object.assign(service, {
      workspace: {
        async getDetail() {
          calls.push("getDetail");
          return { kind: "not_found" };
        },
      },
      async actingWriteClient() {
        calls.push("write");
        throw new Error("no");
      },
    });

    const result = await MrMutationService.prototype.merge.call(service, "user-a", {
      gitlabInstanceId: "inst",
      gitlabProjectId: "1",
      iid: 1,
    }, {
      reviewedHeadSha: "aaa",
      confirmed: false,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "not_confirmed");
    }
    assert.deepEqual(calls, []);
  });

  it("approve blocks stale SHA and audits failure without write", async () => {
    const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const service = Object.create(MrMutationService.prototype) as MrMutationService;
    Object.assign(service, {
      workspace: {
        async getDetail() {
          calls.push("getDetail");
          return {
            gitlabInstanceId: "inst",
            gitlabProjectId: "1",
            pathWithNamespace: "g/p",
            mr: { sha: "sha-b", state: "opened" },
            approvals: null,
            pipelines: [],
            diffs: [],
            reviewedHeadSha: "sha-b",
          };
        },
      },
      async safeAudit(
        action: string,
        _userId: string,
        _ref: unknown,
        meta: Record<string, unknown>,
      ) {
        audits.push({ action, meta });
      },
      async actingWriteClient() {
        calls.push("write");
        throw new Error("no write on stale");
      },
    });

    const result = await MrMutationService.prototype.approve.call(service, "user-a", {
      gitlabInstanceId: "inst",
      gitlabProjectId: "1",
      iid: 9,
    }, {
      reviewedHeadSha: "sha-a",
      confirmed: true,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "stale_sha");
    }
    assert.deepEqual(calls, ["getDetail"]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.action, "mr_approve");
    assert.equal(audits[0]?.meta["category"], "stale_sha");
    assert.equal(audits[0]?.meta["result"], "failure");
  });
});
