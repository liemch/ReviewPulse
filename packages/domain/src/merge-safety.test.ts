/**
 * Pure merge-safety predicate matrix (M2).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateMergeSafety,
  isApprovalsSatisfied,
  isPipelineStatusOk,
  isStaleReview,
  type MergeSafetyInput,
} from "./merge-safety.js";

function base(overrides: Partial<MergeSafetyInput> = {}): MergeSafetyInput {
  return {
    userCanMerge: true,
    reviewedHeadSha: "aaa",
    currentHeadSha: "aaa",
    hasConflicts: false,
    pipelineOk: true,
    approvalsSatisfied: true,
    draft: false,
    confirmed: true,
    ...overrides,
  };
}

describe("evaluateMergeSafety", () => {
  it("blocks when permission is false", () => {
    const result = evaluateMergeSafety(base({ userCanMerge: false }));
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("permission_denied"));
    }
  });

  it("blocks on SHA mismatch", () => {
    const result = evaluateMergeSafety(
      base({ reviewedHeadSha: "aaa", currentHeadSha: "bbb" }),
    );
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("sha_mismatch"));
    }
  });

  it("blocks on conflicts", () => {
    const result = evaluateMergeSafety(base({ hasConflicts: true }));
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("conflicts"));
    }
  });

  it("blocks when pipeline fails", () => {
    const result = evaluateMergeSafety(base({ pipelineOk: false }));
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("pipeline_unsatisfied"));
    }
  });

  it("blocks when approvals insufficient", () => {
    const result = evaluateMergeSafety(base({ approvalsSatisfied: false }));
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("approvals_insufficient"));
    }
  });

  it("blocks draft MRs", () => {
    const result = evaluateMergeSafety(base({ draft: true }));
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("draft"));
    }
  });

  it("blocks without confirmation", () => {
    const result = evaluateMergeSafety(base({ confirmed: false }));
    assert.equal(result.allowed, false);
    if (!result.allowed) {
      assert.ok(result.reasons.includes("not_confirmed"));
    }
  });

  it("allows when all conditions pass", () => {
    const result = evaluateMergeSafety(base());
    assert.deepEqual(result, { allowed: true });
  });
});

describe("helpers", () => {
  it("detects stale review", () => {
    assert.equal(isStaleReview("a", "b"), true);
    assert.equal(isStaleReview("a", "a"), false);
    assert.equal(isStaleReview(null, "a"), true);
  });

  it("evaluates pipeline status", () => {
    assert.equal(isPipelineStatusOk("success"), true);
    assert.equal(isPipelineStatusOk("failed"), false);
    assert.equal(isPipelineStatusOk(null, true), true);
    assert.equal(isPipelineStatusOk(null, false), false);
  });

  it("evaluates approvals", () => {
    assert.equal(
      isApprovalsSatisfied({
        approved: true,
        approvalsRequired: 2,
        approvalsLeft: 1,
      }),
      true,
    );
    assert.equal(
      isApprovalsSatisfied({
        approved: false,
        approvalsRequired: 2,
        approvalsLeft: 0,
      }),
      true,
    );
    assert.equal(
      isApprovalsSatisfied({
        approved: false,
        approvalsRequired: 2,
        approvalsLeft: 1,
      }),
      false,
    );
  });
});
