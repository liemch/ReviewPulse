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
    await this.prisma.membershipCache.deleteMany({
      where: { gitlabInstanceId: instanceId },
    });
    await this.prisma.gitLabInstanceAllowlist.delete({
      where: { id: instanceId },
    });
  }

  async listProjects(instanceId?: string): Promise<ProjectAllowlistRow[]> {
    return await this.prisma.reviewPulseProjectAllowlist.findMany({
      ...(instanceId ? { where: { gitlabInstanceId: instanceId } } : {}),
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        gitlabInstanceId: true,
        gitlabProjectId: true,
        pathWithNamespace: true,
      },
    });
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
    return await this.prisma.reviewPulseProjectAllowlist.create({
      data: {
        gitlabInstanceId: input.gitlabInstanceId,
        gitlabProjectId,
        pathWithNamespace: input.pathWithNamespace ?? null,
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
    if (row) {
      await this.prisma.membershipCache.deleteMany({
        where: {
          gitlabInstanceId: row.gitlabInstanceId,
          gitlabProjectId: row.gitlabProjectId,
        },
      });
    }
    await this.prisma.reviewPulseProjectAllowlist.delete({
      where: { id: allowlistId },
    });
  }
}
