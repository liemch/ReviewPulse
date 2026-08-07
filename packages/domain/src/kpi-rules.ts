/**
 * WP7b — Load versioned KPI rule sets from PostgreSQL.
 */

import type { Prisma, PrismaClient } from "@reviewpulse/db";

import { KPI_RULESET_ROLE, KPI_RULESET_VERSION } from "./metrics/types.js";

export type LoadedKpiRuleSet = {
  id: string;
  role: string;
  version: string;
  effectiveFrom: Date;
  notesJson: Prisma.JsonValue;
  rules: Array<{
    metricKey: string;
    referenceMin: number | null;
    referenceMax: number | null;
    unit: string | null;
    detectionRule: string | null;
    optionsJson: Prisma.JsonValue;
    status: "active" | "inactive";
  }>;
};

export class KpiRulesStore {
  constructor(private readonly prisma: PrismaClient) {}

  async loadDevReference(
    version: string = KPI_RULESET_VERSION,
  ): Promise<LoadedKpiRuleSet | null> {
    const row = await this.prisma.kpiRuleSet.findUnique({
      where: {
        role_version: { role: KPI_RULESET_ROLE, version },
      },
      include: { rules: true },
    });
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      role: row.role,
      version: row.version,
      effectiveFrom: row.effectiveFrom,
      notesJson: row.notesJson,
      rules: row.rules.map((rule) => ({
        metricKey: rule.metricKey,
        referenceMin: rule.referenceMin,
        referenceMax: rule.referenceMax,
        unit: rule.unit,
        detectionRule: rule.detectionRule,
        optionsJson: rule.optionsJson,
        status: rule.status,
      })),
    };
  }
}
