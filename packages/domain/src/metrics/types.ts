/**
 * WP7b — Metric DTO shape. Allowed fields only; never score/grade/pass/fail.
 */

export const FORBIDDEN_METRIC_KEYS = [
  "score",
  "grade",
  "pass",
  "fail",
  "verdict",
  "dat",
  "khong_dat",
  "prompts_inferred",
] as const;

export type MetricStatus = "ok" | "unknown" | "not_configured";

export type ReferenceRange = {
  min: number | null;
  max: number | null;
};

export type MetricDto = {
  metric: string;
  value: number | null;
  unit: string | null;
  reference_range: ReferenceRange;
  source: string;
  calculated_at: string;
  verification_status: string | null;
  rule_version: string;
  detection_rule: string | null;
  status: MetricStatus;
  reference_policy_note: string | null;
};

export type MetricCommitInput = {
  gitlabInstanceId: string;
  gitlabProjectId: string;
  sha: string;
  title: string | null;
  authorEmailNormalized: string | null;
  authoredAt: Date;
};

export const KPI_RULESET_VERSION = "dev-kpi-ref-2026.08.1";
export const KPI_RULESET_ROLE = "DEV";

/** Assert a metric DTO never carries forbidden verdict fields. */
export function assertNoForbiddenMetricFields(
  dto: Record<string, unknown>,
): void {
  for (const key of FORBIDDEN_METRIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(dto, key)) {
      throw new Error(`Forbidden metric field present: ${key}`);
    }
  }
}

export function toPublicMetric(dto: MetricDto): MetricDto {
  assertNoForbiddenMetricFields(dto as unknown as Record<string, unknown>);
  return { ...dto };
}
