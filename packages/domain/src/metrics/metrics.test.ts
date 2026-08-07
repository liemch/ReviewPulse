import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countAiAssistedCommits,
  subjectHasAiTag,
} from "./ai-tag.js";
import {
  countCommitFrequency,
  isExcludedFromFrequency,
  weekWindowAsiaHoChiMinh,
} from "./commit-frequency.js";
import { calculateReferenceMetrics } from "./index.js";
import {
  assertNoForbiddenMetricFields,
  FORBIDDEN_METRIC_KEYS,
  type MetricCommitInput,
} from "./types.js";

function commit(
  overrides: Partial<MetricCommitInput> & Pick<MetricCommitInput, "sha" | "authoredAt">,
): MetricCommitInput {
  return {
    gitlabInstanceId: "inst",
    gitlabProjectId: "1",
    title: "feat: change",
    authorEmailNormalized: "dev@example.com",
    ...overrides,
  };
}

describe("subjectHasAiTag", () => {
  it("counts bracketed AI tags case-insensitively", () => {
    assert.equal(subjectHasAiTag("[AI] refactor module"), true);
    assert.equal(subjectHasAiTag("[ai] add tests"), true);
    assert.equal(subjectHasAiTag("fix: timeout [AI]"), true);
  });

  it("rejects unbracketed AI mentions", () => {
    assert.equal(subjectHasAiTag("AI refactor module"), false);
    assert.equal(subjectHasAiTag("aided by ai tools"), false);
    assert.equal(subjectHasAiTag(null), false);
  });
});

describe("countAiAssistedCommits", () => {
  it("dedupes by instance+project+sha", () => {
    const at = new Date("2026-08-04T10:00:00.000Z");
    const n = countAiAssistedCommits([
      commit({ sha: "aaa", title: "[AI] one", authoredAt: at }),
      commit({ sha: "aaa", title: "[AI] one again", authoredAt: at }),
      commit({ sha: "bbb", title: "plain", authoredAt: at }),
      commit({ sha: "ccc", title: "fix [ai]", authoredAt: at }),
    ]);
    assert.equal(n, 2);
  });
});

describe("countCommitFrequency", () => {
  const start = new Date("2026-08-03T17:00:00.000Z"); // Mon 00:00 ICT
  const end = new Date("2026-08-10T17:00:00.000Z");

  it("counts SHAs inside the window and excludes merge/bot", () => {
    const n = countCommitFrequency(
      [
        commit({
          sha: "1",
          authoredAt: new Date("2026-08-04T01:00:00.000Z"),
        }),
        commit({
          sha: "1",
          authoredAt: new Date("2026-08-05T01:00:00.000Z"),
        }),
        commit({
          sha: "2",
          title: "Merge branch 'x'",
          authoredAt: new Date("2026-08-04T02:00:00.000Z"),
        }),
        commit({
          sha: "3",
          authorEmailNormalized: "dependabot@users.noreply.github.com",
          authoredAt: new Date("2026-08-04T03:00:00.000Z"),
        }),
        commit({
          sha: "4",
          authoredAt: new Date("2026-08-01T01:00:00.000Z"),
        }),
      ],
      start,
      end,
    );
    assert.equal(n, 1);
    assert.equal(
      isExcludedFromFrequency(
        commit({
          sha: "x",
          title: "Merge branch 'x'",
          authoredAt: start,
        }),
      ),
      true,
    );
  });
});

describe("weekWindowAsiaHoChiMinh", () => {
  it("returns a Monday–Sunday window in +07", () => {
    // Wednesday 2026-08-05 12:00 ICT = 05:00Z
    const { windowStart, windowEnd } = weekWindowAsiaHoChiMinh(
      new Date("2026-08-05T05:00:00.000Z"),
    );
    assert.equal(windowStart.toISOString(), "2026-08-02T17:00:00.000Z");
    assert.equal(windowEnd.toISOString(), "2026-08-09T17:00:00.000Z");
  });
});

describe("calculateReferenceMetrics", () => {
  it("returns frequency + AI metrics and not_configured stubs without forbidden fields", () => {
    const now = new Date("2026-08-05T05:00:00.000Z");
    const metrics = calculateReferenceMetrics({
      now,
      commits: [
        commit({
          sha: "a1",
          title: "[AI] work",
          authoredAt: new Date("2026-08-04T01:00:00.000Z"),
        }),
        commit({
          sha: "a2",
          title: "plain",
          authoredAt: new Date("2026-08-04T02:00:00.000Z"),
        }),
      ],
      rules: [
        {
          metricKey: "commit_frequency",
          referenceMin: 3,
          referenceMax: 8,
          unit: "commits_per_week",
          detectionRule: null,
          optionsJson: {},
          status: "active",
        },
        {
          metricKey: "ai_assisted_commits",
          referenceMin: null,
          referenceMax: null,
          unit: "commits",
          detectionRule: "\\[[Aa][Ii]\\]",
          optionsJson: {},
          status: "active",
        },
        {
          metricKey: "loc_weekly",
          referenceMin: 500,
          referenceMax: null,
          unit: "loc_per_week",
          detectionRule: null,
          optionsJson: {},
          status: "active",
        },
        {
          metricKey: "mr_size",
          referenceMin: null,
          referenceMax: 400,
          unit: "lines_per_mr",
          detectionRule: null,
          optionsJson: {},
          status: "active",
        },
      ],
    });

    const byKey = Object.fromEntries(metrics.map((m) => [m.metric, m]));
    assert.equal(byKey.commit_frequency?.value, 2);
    assert.equal(byKey.commit_frequency?.reference_range.min, 3);
    assert.equal(byKey.commit_frequency?.reference_range.max, 8);
    assert.equal(byKey.ai_assisted_commits?.value, 1);
    assert.equal(byKey.ai_assisted_commits?.verification_status, "self_reported");
    assert.equal(byKey.loc_weekly?.status, "not_configured");
    assert.equal(byKey.mr_size?.status, "not_configured");

    for (const metric of metrics) {
      assertNoForbiddenMetricFields(
        metric as unknown as Record<string, unknown>,
      );
      for (const key of FORBIDDEN_METRIC_KEYS) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(metric, key),
          false,
        );
      }
    }
  });

  it("rejects DTOs that smuggle verdict fields", () => {
    assert.throws(
      () =>
        assertNoForbiddenMetricFields({
          metric: "x",
          score: 99,
        }),
      /Forbidden metric field/,
    );
  });
});
