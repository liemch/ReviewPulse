/**
 * WP7b — Compose reference metrics from authz-filtered commits + versioned rules.
 */

import type { KpiRule } from "@reviewpulse/db";

import { countAiAssistedCommits, AI_TAG_SUBJECT_REGEX } from "./ai-tag.js";
import {
  countCommitFrequency,
  weekWindowAsiaHoChiMinh,
} from "./commit-frequency.js";
import {
  KPI_RULESET_VERSION,
  toPublicMetric,
  type MetricCommitInput,
  type MetricDto,
} from "./types.js";

export {
  countAiAssistedCommits,
  subjectHasAiTag,
  AI_TAG_SUBJECT_REGEX,
} from "./ai-tag.js";
export {
  countCommitFrequency,
  isExcludedFromFrequency,
  weekWindowAsiaHoChiMinh,
} from "./commit-frequency.js";
export {
  assertNoForbiddenMetricFields,
  FORBIDDEN_METRIC_KEYS,
  KPI_RULESET_ROLE,
  KPI_RULESET_VERSION,
  toPublicMetric,
  type MetricCommitInput,
  type MetricDto,
  type MetricStatus,
  type ReferenceRange,
} from "./types.js";

export type KpiRuleView = Pick<
  KpiRule,
  | "metricKey"
  | "referenceMin"
  | "referenceMax"
  | "unit"
  | "detectionRule"
  | "optionsJson"
  | "status"
>;

function ruleByKey(
  rules: readonly KpiRuleView[],
  key: string,
): KpiRuleView | undefined {
  return rules.find((rule) => rule.metricKey === key && rule.status === "active");
}

function baseDto(
  metric: string,
  rule: KpiRuleView | undefined,
  calculatedAt: Date,
  extras: Partial<MetricDto>,
): MetricDto {
  return toPublicMetric({
    metric,
    value: null,
    unit: rule?.unit ?? null,
    reference_range: {
      min: rule?.referenceMin ?? null,
      max: rule?.referenceMax ?? null,
    },
    source: "gitlab",
    calculated_at: calculatedAt.toISOString(),
    verification_status: null,
    rule_version: KPI_RULESET_VERSION,
    detection_rule: rule?.detectionRule ?? null,
    status: "ok",
    reference_policy_note: null,
    ...extras,
  });
}

export function calculateReferenceMetrics(input: {
  commits: readonly MetricCommitInput[];
  rules: readonly KpiRuleView[];
  now?: Date;
  policyNote?: string | null;
}): MetricDto[] {
  const now = input.now ?? new Date();
  const { windowStart, windowEnd } = weekWindowAsiaHoChiMinh(now);
  const inWindow = input.commits.filter((commit) => {
    const at = commit.authoredAt.getTime();
    return at >= windowStart.getTime() && at < windowEnd.getTime();
  });

  const freqRule = ruleByKey(input.rules, "commit_frequency");
  const aiRule = ruleByKey(input.rules, "ai_assisted_commits");
  const locRule = ruleByKey(input.rules, "loc_weekly");
  const mrRule = ruleByKey(input.rules, "mr_size");

  const frequency = countCommitFrequency(input.commits, windowStart, windowEnd);
  const aiCount = countAiAssistedCommits(inWindow);

  return [
    baseDto("commit_frequency", freqRule, now, {
      value: frequency,
      unit: freqRule?.unit ?? "commits_per_week",
      status: "ok",
      verification_status: "observed",
    }),
    baseDto("ai_assisted_commits", aiRule, now, {
      value: aiCount,
      unit: aiRule?.unit ?? "commits",
      status: "ok",
      verification_status: "self_reported",
      detection_rule:
        aiRule?.detectionRule ?? AI_TAG_SUBJECT_REGEX.source,
    }),
    baseDto("loc_weekly", locRule, now, {
      value: null,
      unit: locRule?.unit ?? "loc_per_week",
      status: "not_configured",
      reference_policy_note:
        input.policyNote ??
        "LOC formula not locked for M1; reference ≥500 is display-only.",
    }),
    baseDto("mr_size", mrRule, now, {
      value: null,
      unit: mrRule?.unit ?? "lines_per_mr",
      status: "not_configured",
      reference_policy_note:
        "Merge Request size requires locked stats formula; deferred past M1 heavy-diff analysis.",
    }),
  ];
}
