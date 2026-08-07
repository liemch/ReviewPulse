/**
 * WP7 — Authz-first dashboard query over sync caches + reference metrics.
 */

import type { PrismaClient } from "@reviewpulse/db";

import { KpiRulesStore } from "./kpi-rules.js";
import {
  calculateReferenceMetrics,
  weekWindowAsiaHoChiMinh,
  type MetricCommitInput,
  type MetricDto,
} from "./metrics/index.js";
import type { ProjectAccessService, ProjectRef } from "./types.js";

export type DashboardFilters = {
  from?: Date | undefined;
  to?: Date | undefined;
  authorEmailNormalized?: string | null | undefined;
  limit?: number | undefined;
};

export type DashboardCommitRow = {
  gitlabInstanceId: string;
  gitlabProjectId: string;
  sha: string;
  title: string | null;
  authorEmail: string | null;
  authorEmailNormalized: string | null;
  authoredAt: Date;
  webUrl: string | null;
  emailMismatch: boolean;
};

export type DashboardMrRow = {
  gitlabInstanceId: string;
  gitlabProjectId: string;
  iid: number;
  title: string | null;
  state: string | null;
  authorEmail: string | null;
  authorEmailNormalized: string | null;
  updatedAt: Date;
  webUrl: string | null;
  emailMismatch: boolean;
};

export type DashboardEmailView = {
  email: string;
  normalizedEmail: string;
  verificationStatus: string;
  source: string;
};

export type DashboardResult = {
  authorizedProjects: ProjectRef[];
  emails: DashboardEmailView[];
  windowStart: Date;
  windowEnd: Date;
  commits: DashboardCommitRow[];
  mergeRequests: {
    open: DashboardMrRow[];
    merged: DashboardMrRow[];
    all: DashboardMrRow[];
  };
  metrics: MetricDto[];
  mismatchCount: number;
};

const DEFAULT_LIMIT = 100;

export class DashboardQueryService {
  private readonly kpiRules: KpiRulesStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly projects: ProjectAccessService,
    kpiRules?: KpiRulesStore,
  ) {
    this.kpiRules = kpiRules ?? new KpiRulesStore(prisma);
  }

  async query(
    userId: string,
    filters: DashboardFilters = {},
  ): Promise<DashboardResult> {
    const authorizedProjects = await this.projects.authorizedProjectIds(userId);
    const week = weekWindowAsiaHoChiMinh();
    const windowStart = filters.from ?? week.windowStart;
    const windowEnd = filters.to ?? week.windowEnd;
    const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), 500);

    const emails = await this.prisma.userEmail.findMany({
      where: { userId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    const emailViews: DashboardEmailView[] = emails.map((row) => ({
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      verificationStatus: row.verificationStatus,
      source: row.source,
    }));
    const emailSet = new Set(emailViews.map((e) => e.normalizedEmail));

    if (authorizedProjects.length === 0) {
      const ruleset = await this.kpiRules.loadDevReference();
      const metrics = calculateReferenceMetrics({
        commits: [],
        rules: ruleset?.rules ?? [],
      });
      return {
        authorizedProjects,
        emails: emailViews,
        windowStart,
        windowEnd,
        commits: [],
        mergeRequests: { open: [], merged: [], all: [] },
        metrics,
        mismatchCount: 0,
      };
    }

    const projectOr = authorizedProjects.map((p) => ({
      gitlabInstanceId: p.gitlabInstanceId,
      gitlabProjectId: p.gitlabProjectId,
    }));

    const authorFilter =
      filters.authorEmailNormalized &&
      filters.authorEmailNormalized.trim().length > 0
        ? filters.authorEmailNormalized.trim().toLowerCase()
        : null;

    const commitRows = await this.prisma.commitCache.findMany({
      where: {
        OR: projectOr,
        authoredAt: { gte: windowStart, lt: windowEnd },
        ...(authorFilter
          ? { authorEmailNormalized: authorFilter }
          : {}),
      },
      orderBy: { authoredAt: "desc" },
      take: limit,
    });

    const mrRows = await this.prisma.mergeRequestCache.findMany({
      where: {
        OR: projectOr,
        updatedAt: { gte: windowStart, lt: windowEnd },
        ...(authorFilter
          ? { authorEmailNormalized: authorFilter }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    const commits: DashboardCommitRow[] = commitRows.map((row) => {
      const normalized = row.authorEmailNormalized;
      const mismatch =
        normalized === null || normalized.length === 0
          ? true
          : !emailSet.has(normalized);
      return {
        gitlabInstanceId: row.gitlabInstanceId,
        gitlabProjectId: row.gitlabProjectId,
        sha: row.sha,
        title: row.title,
        authorEmail: row.authorEmail,
        authorEmailNormalized: row.authorEmailNormalized,
        authoredAt: row.authoredAt,
        webUrl: row.webUrl,
        emailMismatch: mismatch,
      };
    });

    const mergeRequests: DashboardMrRow[] = mrRows.map((row) => {
      const normalized = row.authorEmailNormalized;
      const mismatch =
        normalized === null || normalized.length === 0
          ? true
          : !emailSet.has(normalized);
      return {
        gitlabInstanceId: row.gitlabInstanceId,
        gitlabProjectId: row.gitlabProjectId,
        iid: row.iid,
        title: row.title,
        state: row.state,
        authorEmail: row.authorEmail,
        authorEmailNormalized: row.authorEmailNormalized,
        updatedAt: row.updatedAt,
        webUrl: row.webUrl,
        emailMismatch: mismatch,
      };
    });

    // Metrics use all authz-filtered commits in the week window (not author filter).
    const metricCommits = await this.prisma.commitCache.findMany({
      where: {
        OR: projectOr,
        authoredAt: { gte: windowStart, lt: windowEnd },
      },
      select: {
        gitlabInstanceId: true,
        gitlabProjectId: true,
        sha: true,
        title: true,
        authorEmailNormalized: true,
        authoredAt: true,
      },
    });
    const metricInputs: MetricCommitInput[] = metricCommits.map((row) => ({
      gitlabInstanceId: row.gitlabInstanceId,
      gitlabProjectId: row.gitlabProjectId,
      sha: row.sha,
      title: row.title,
      authorEmailNormalized: row.authorEmailNormalized,
      authoredAt: row.authoredAt,
    }));

    const ruleset = await this.kpiRules.loadDevReference();
    const metrics = calculateReferenceMetrics({
      commits: metricInputs,
      rules: ruleset?.rules ?? [],
      now: windowEnd,
    });

    await this.persistSnapshots(userId, authorizedProjects, metrics, windowStart, windowEnd);

    const mismatchCount =
      commits.filter((c) => c.emailMismatch).length +
      mergeRequests.filter((m) => m.emailMismatch).length;

    return {
      authorizedProjects,
      emails: emailViews,
      windowStart,
      windowEnd,
      commits,
      mergeRequests: {
        open: mergeRequests.filter(
          (m) => m.state === "opened" || m.state === "open",
        ),
        merged: mergeRequests.filter((m) => m.state === "merged"),
        all: mergeRequests,
      },
      metrics,
      mismatchCount,
    };
  }

  /**
   * Append-only snapshots. Changing rule_version never updates old rows.
   */
  private async persistSnapshots(
    userId: string,
    projects: ProjectRef[],
    metrics: MetricDto[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<void> {
    const scope =
      projects.length === 1
        ? `${projects[0]!.gitlabInstanceId}:${projects[0]!.gitlabProjectId}`
        : `multi:${projects.length}`;
    for (const metric of metrics) {
      const existing = await this.prisma.metricSnapshot.findFirst({
        where: {
          userId,
          projectScope: scope,
          metricKey: metric.metric,
          ruleVersion: metric.rule_version,
          windowStart,
          windowEnd,
        },
        select: { id: true },
      });
      if (existing) {
        continue;
      }
      await this.prisma.metricSnapshot.create({
        data: {
          userId,
          projectScope: scope,
          metricKey: metric.metric,
          valueNullable: metric.value,
          unit: metric.unit,
          verificationStatus: metric.verification_status,
          ruleVersion: metric.rule_version,
          source: metric.source,
          detectionRule: metric.detection_rule,
          calculatedAt: new Date(metric.calculated_at),
          windowStart,
          windowEnd,
          status: metric.status,
        },
      });
    }
  }
}
