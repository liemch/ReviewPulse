/** Admin instance/project allowlist management. */

import type { PrismaClient } from "@reviewpulse/db";
import { normalizeGitLabBaseUrl } from "@reviewpulse/gitlab-client";

export type InstanceAllowlistRow = {
  id: string;
  baseUrlNormalized: string;
  label: string | null;
  internal: boolean;
};

export type ProjectAllowlistRow = {
  id: string;
  gitlabInstanceId: string;
  gitlabProjectId: string;
  pathWithNamespace: string | null;
};

export class AllowlistAdminService {
  constructor(private readonly prisma: PrismaClient) {}

  async listInstances(): Promise<InstanceAllowlistRow[]> {
    return await this.prisma.gitLabInstanceAllowlist.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        baseUrlNormalized: true,
        label: true,
        internal: true,
      },
    });
  }

  async addInstance(input: {
    baseUrl: string;
    label?: string | null;
    internal?: boolean;
    requireHttps?: boolean;
  }): Promise<InstanceAllowlistRow> {
    const baseUrlNormalized = normalizeGitLabBaseUrl(input.baseUrl, {
      requireHttps: input.requireHttps ?? true,
    });
    return await this.prisma.gitLabInstanceAllowlist.create({
      data: {
        baseUrlNormalized,
        label: input.label ?? null,
        internal: input.internal ?? false,
      },
      select: {
        id: true,
        baseUrlNormalized: true,
        label: true,
        internal: true,
      },
    });
  }

  async removeInstance(instanceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipCache.deleteMany({
        where: { gitlabInstanceId: instanceId },
      });
      await tx.userProjectEnable.deleteMany({
        where: { gitlabInstanceId: instanceId },
      });
      await tx.syncJob.updateMany({
        where: {
          jobType: "project_sync",
          gitlabInstanceId: instanceId,
          status: { in: ["pending", "running"] },
        },
        data: {
          status: "sync_blocked",
          claimedBy: null,
          claimedAt: null,
          lastError: "GitLab instance removed from allowlist",
        },
      });
      await tx.gitLabInstanceAllowlist.delete({
        where: { id: instanceId },
      });
    });
  }

  async listProjects(instanceId?: string): Promise<ProjectAllowlistRow[]> {
    const rows = await this.prisma.reviewPulseProjectAllowlist.findMany({
      ...(instanceId ? { where: { gitlabInstanceId: instanceId } } : {}),
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        gitlabInstanceId: true,
        gitlabProjectId: true,
        pathWithNamespace: true,
      },
    });
    // Rows added before paths were normalized can hold "", which reads as a
    // present-but-empty label at every render site.
    return rows.map((row) => ({
      ...row,
      pathWithNamespace:
        (row.pathWithNamespace?.trim().length ?? 0) > 0
          ? row.pathWithNamespace
          : null,
    }));
  }

  async addProject(input: {
    gitlabInstanceId: string;
    gitlabProjectId: string;
    pathWithNamespace?: string | null;
  }): Promise<ProjectAllowlistRow> {
    const gitlabProjectId = String(input.gitlabProjectId).trim();
    if (!/^\d+$/.test(gitlabProjectId)) {
      throw new Error("gitlab_project_id must be numeric");
    }
    // An HTML form always submits the optional path field, so an omitted path
    // arrives as "" and would otherwise be stored as a displayable value.
    const pathWithNamespace = input.pathWithNamespace?.trim() ?? "";
    return await this.prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: input.gitlabInstanceId,
        gitlabProjectId,
        pathWithNamespace:
          pathWithNamespace.length > 0 ? pathWithNamespace : null,
      },
      select: {
        id: true,
        gitlabInstanceId: true,
        gitlabProjectId: true,
        pathWithNamespace: true,
      },
    });
  }

  async removeProject(allowlistId: string): Promise<void> {
    const row = await this.prisma.reviewPulseProjectAllowlist.findUnique({
      where: { id: allowlistId },
      select: { gitlabInstanceId: true, gitlabProjectId: true },
    });
    if (!row) {
      return;
    }

    const project = {
      gitlabInstanceId: row.gitlabInstanceId,
      gitlabProjectId: row.gitlabProjectId,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipCache.deleteMany({ where: project });
      await tx.userProjectEnable.deleteMany({ where: project });
      await tx.syncJob.updateMany({
        where: {
          jobType: "project_sync",
          ...project,
          status: { in: ["pending", "running"] },
        },
        data: {
          status: "sync_blocked",
          claimedBy: null,
          claimedAt: null,
          lastError: "Project removed from allowlist",
        },
      });
      await tx.reviewPulseProjectAllowlist.delete({
        where: { id: allowlistId },
      });
    });
  }
}
