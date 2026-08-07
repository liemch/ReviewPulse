/**
 * Idempotent seed for M1 KPI reference ruleset `dev-kpi-ref-2026.08.1`.
 *
 * Usage: npm run db:seed:kpi
 */
import type { Prisma } from "@reviewpulse/db";
import { getPrisma, disconnectDatabase } from "./index.js";
import { loadMonorepoEnv } from "./load-env.js";

const VERSION = "dev-kpi-ref-2026.08.1";
const ROLE = "DEV";

async function main(): Promise<void> {
  loadMonorepoEnv();
  const prisma = getPrisma();

  const notesJson: Prisma.InputJsonValue = {
    timezone: "Asia/Ho_Chi_Minh",
    week_starts: "Monday",
    assumptions: {
      exclude_merge_commits: true,
      exclude_bot_authors: true,
      include_unmerged: true,
      include_reverts: true,
    },
    policy_notes: {
      prompts_per_week:
        "10-30 (policy origin only — not comparable to AI-assisted commits)",
    },
  };

  const ruleset = await prisma.kpiRuleSet.upsert({
    where: { role_version: { role: ROLE, version: VERSION } },
    create: {
      role: ROLE,
      version: VERSION,
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      notesJson,
    },
    update: { notesJson },
  });

  const rules: Array<{
    metricKey: string;
    referenceMin: number | null;
    referenceMax: number | null;
    unit: string;
    detectionRule: string | null;
    optionsJson: Prisma.InputJsonValue;
  }> = [
    {
      metricKey: "commit_frequency",
      referenceMin: 3,
      referenceMax: 8,
      unit: "commits_per_week",
      detectionRule: null,
      optionsJson: {
        timezone: "Asia/Ho_Chi_Minh",
        week_starts: "Monday",
        exclude_merge_commits: true,
        exclude_bot_authors: true,
      },
    },
    {
      metricKey: "ai_assisted_commits",
      referenceMin: null,
      referenceMax: null,
      unit: "commits",
      detectionRule: "\\[[Aa][Ii]\\]",
      optionsJson: {
        verification_status: "self_reported",
        subject_only: true,
      },
    },
    {
      metricKey: "loc_weekly",
      referenceMin: 500,
      referenceMax: null,
      unit: "loc_per_week",
      detectionRule: null,
      optionsJson: { m1_status: "not_configured" },
    },
    {
      metricKey: "mr_size",
      referenceMin: null,
      referenceMax: 400,
      unit: "lines_per_mr",
      detectionRule: null,
      optionsJson: { m1_status: "not_configured", terminology: "Merge Request" },
    },
  ];

  for (const rule of rules) {
    await prisma.kpiRule.upsert({
      where: {
        rulesetId_metricKey: {
          rulesetId: ruleset.id,
          metricKey: rule.metricKey,
        },
      },
      create: {
        rulesetId: ruleset.id,
        metricKey: rule.metricKey,
        referenceMin: rule.referenceMin,
        referenceMax: rule.referenceMax,
        unit: rule.unit,
        detectionRule: rule.detectionRule,
        optionsJson: rule.optionsJson,
        status: "active",
      },
      update: {
        referenceMin: rule.referenceMin,
        referenceMax: rule.referenceMax,
        unit: rule.unit,
        detectionRule: rule.detectionRule,
        optionsJson: rule.optionsJson,
        status: "active",
      },
    });
  }

  console.log(
    JSON.stringify({
      check: "kpi_seed",
      status: "ok",
      role: ROLE,
      version: VERSION,
      rules: rules.length,
    }),
  );
}

void main()
  .catch((error) => {
    console.error("[reviewpulse:kpi-seed] failed");
    console.error(String((error as Error)?.message ?? error).slice(0, 200));
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
