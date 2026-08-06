/** Per-user GitLab connection Settings (WP3b). */

import type { PrismaClient } from "@reviewpulse/db";
import type { PatCredentialProvider } from "@reviewpulse/credentials";
import {
  createGitLabAllowlist,
  createGitLabReadClient,
  createPatAuthAdapter,
  createSsrfGuard,
  GitLabUnauthorizedError,
  normalizeGitLabBaseUrl,
} from "@reviewpulse/gitlab-client";

export type ConnectionView = {
  id: string;
  gitlabInstanceId: string;
  baseUrlNormalized: string;
  gitlabUserId: string;
  gitlabUsername: string;
  status: string;
  lastValidatedAt: Date | null;
  patHintLast4: string | null;
};

export type TestConnectionResult = {
  gitlabUserId: string;
  gitlabUsername: string;
  email: string | null;
  name: string | null;
};

/**
 * Resolves the GitLab identity behind a PAT. The default implementation is the
 * WP2 read client with the SSRF guard; tests inject a stub so they never need a
 * live GitLab (loopback is denied by policy, allowlisted or not).
 */
export type GitLabIdentityProbe = (input: {
  instanceId: string;
  baseUrlNormalized: string;
  internal: boolean;
  pat: string;
}) => Promise<TestConnectionResult>;

export function createGitLabIdentityProbe(): GitLabIdentityProbe {
  return async (input) => {
    const client = createGitLabReadClient({
      instance: {
        instanceId: input.instanceId,
        baseUrlNormalized: input.baseUrlNormalized,
      },
      auth: createPatAuthAdapter(() => input.pat),
      ssrf: createSsrfGuard({
        allowlist: createGitLabAllowlist([
          { url: input.baseUrlNormalized, internal: input.internal },
        ]),
      }),
    });

    const user = await client.getCurrentUser();
    return {
      gitlabUserId: String(user.id),
      gitlabUsername: user.username,
      email: user.email,
      name: user.name,
    };
  };
}

export class GitLabConnectionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentials: PatCredentialProvider,
    private readonly probeIdentity: GitLabIdentityProbe = createGitLabIdentityProbe(),
  ) {}

  async listForUser(userId: string): Promise<ConnectionView[]> {
    const rows = await this.prisma.gitLabConnection.findMany({
      where: {
        userId,
        status: { in: ["active", "invalid"] },
      },
      include: {
        instance: true,
        credentials: {
          where: { status: { in: ["active", "invalid"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      gitlabInstanceId: row.gitlabInstanceId,
      baseUrlNormalized: row.instance.baseUrlNormalized,
      gitlabUserId: row.gitlabUserId,
      gitlabUsername: row.gitlabUsername,
      status: row.status,
      lastValidatedAt: row.lastValidatedAt,
      patHintLast4: row.credentials[0]?.patHintLast4 ?? null,
    }));
  }

  async testPat(input: {
    baseUrl: string;
    pat: string;
    requireHttps?: boolean;
  }): Promise<TestConnectionResult & { instanceId: string; internal: boolean }> {
    const baseUrlNormalized = normalizeGitLabBaseUrl(input.baseUrl, {
      requireHttps: input.requireHttps ?? true,
    });
    const instance = await this.prisma.gitLabInstanceAllowlist.findUnique({
      where: { baseUrlNormalized },
    });
    if (instance === null) {
      throw new ConnectionPolicyError("GitLab URL is not allowlisted");
    }

    try {
      const identity = await this.probeIdentity({
        instanceId: instance.id,
        baseUrlNormalized: instance.baseUrlNormalized,
        internal: instance.internal,
        pat: input.pat,
      });
      return {
        instanceId: instance.id,
        internal: instance.internal,
        ...identity,
      };
    } catch (error) {
      if (error instanceof GitLabUnauthorizedError) {
        throw new ConnectionPolicyError("GitLab credential was rejected");
      }
      throw error;
    }
  }

  async saveConnection(input: {
    userId: string;
    baseUrl: string;
    pat: string;
    requireHttps?: boolean;
  }): Promise<ConnectionView> {
    const tested = await this.testPat({
      baseUrl: input.baseUrl,
      pat: input.pat,
      ...(input.requireHttps !== undefined
        ? { requireHttps: input.requireHttps }
        : {}),
    });

    try {
      const connection = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.gitLabConnection.findFirst({
          where: {
            userId: input.userId,
            gitlabInstanceId: tested.instanceId,
            status: { in: ["active", "invalid"] },
          },
        });

        if (existing) {
          const updated = await tx.gitLabConnection.update({
            where: { id: existing.id },
            data: {
              gitlabUserId: tested.gitlabUserId,
              gitlabUsername: tested.gitlabUsername,
              status: "active",
              lastValidatedAt: new Date(),
            },
            include: { instance: true },
          });
          return updated;
        }

        return await tx.gitLabConnection.create({
          data: {
            userId: input.userId,
            gitlabInstanceId: tested.instanceId,
            gitlabUserId: tested.gitlabUserId,
            gitlabUsername: tested.gitlabUsername,
            status: "active",
            lastValidatedAt: new Date(),
          },
          include: { instance: true },
        });
      });

      const existingCred = await this.prisma.userCredential.findFirst({
        where: { connectionId: connection.id, status: "active" },
      });
      const stored = existingCred
        ? await this.credentials.replaceCredential(connection.id, input.pat)
        : await this.credentials.storeCredential(connection.id, input.pat);

      if (tested.email) {
        await this.upsertGitlabEmail(input.userId, tested.email);
      }

      await this.prisma.membershipCache.deleteMany({
        where: {
          userId: input.userId,
          gitlabInstanceId: connection.gitlabInstanceId,
        },
      });

      return {
        id: connection.id,
        gitlabInstanceId: connection.gitlabInstanceId,
        baseUrlNormalized: connection.instance.baseUrlNormalized,
        gitlabUserId: connection.gitlabUserId,
        gitlabUsername: connection.gitlabUsername,
        status: connection.status,
        lastValidatedAt: connection.lastValidatedAt,
        patHintLast4: stored.patHintLast4,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002") {
        throw new ConnectionPolicyError(
          "This GitLab identity is already linked to another account",
        );
      }
      throw error;
    }
  }

  async deleteConnection(input: {
    userId: string;
    connectionId: string;
  }): Promise<void> {
    const connection = await this.prisma.gitLabConnection.findFirst({
      where: { id: input.connectionId, userId: input.userId },
    });
    if (connection === null) {
      throw new ConnectionPolicyError("Connection not found");
    }

    await this.credentials.invalidateCredential(
      connection.id,
      "connection_deleted",
    );
    await this.prisma.gitLabConnection.update({
      where: { id: connection.id },
      data: { status: "deleted" },
    });
    await this.prisma.membershipCache.deleteMany({
      where: {
        userId: input.userId,
        gitlabInstanceId: connection.gitlabInstanceId,
      },
    });
  }

  async retestStored(input: {
    userId: string;
    connectionId: string;
  }): Promise<ConnectionView> {
    const connection = await this.prisma.gitLabConnection.findFirst({
      where: {
        id: input.connectionId,
        userId: input.userId,
        status: { in: ["active", "invalid"] },
      },
      include: { instance: true },
    });
    if (connection === null) {
      throw new ConnectionPolicyError("Connection not found");
    }

    let pat: string;
    try {
      pat = await this.credentials.getAccessToken(connection.id);
    } catch {
      throw new ConnectionPolicyError("No active credential");
    }

    try {
      const tested = await this.testPat({
        baseUrl: connection.instance.baseUrlNormalized,
        pat,
        requireHttps: connection.instance.baseUrlNormalized.startsWith("https:"),
      });
      await this.prisma.gitLabConnection.update({
        where: { id: connection.id },
        data: {
          status: "active",
          gitlabUsername: tested.gitlabUsername,
          lastValidatedAt: new Date(),
        },
      });
    } catch (error) {
      if (
        error instanceof ConnectionPolicyError ||
        error instanceof GitLabUnauthorizedError
      ) {
        await this.credentials.invalidateCredential(
          connection.id,
          "gitlab_unauthorized",
        );
        await this.prisma.gitLabConnection.update({
          where: { id: connection.id },
          data: { status: "invalid" },
        });
        await this.prisma.membershipCache.deleteMany({
          where: {
            userId: input.userId,
            gitlabInstanceId: connection.gitlabInstanceId,
          },
        });
      }
      throw error;
    }

    const views = await this.listForUser(input.userId);
    const view = views.find((row) => row.id === connection.id);
    if (!view) {
      throw new ConnectionPolicyError("Connection not found");
    }
    return view;
  }

  private async upsertGitlabEmail(userId: string, email: string): Promise<void> {
    const normalized = email.trim().normalize("NFKC").toLowerCase();
    if (!normalized.includes("@")) {
      return;
    }
    await this.prisma.userEmail.upsert({
      where: {
        userId_normalizedEmail: {
          userId,
          normalizedEmail: normalized,
        },
      },
      create: {
        userId,
        email: email.trim(),
        normalizedEmail: normalized,
        source: "gitlab_primary",
        verificationStatus: "gitlab_unverified",
        isPrimary: false,
      },
      update: {
        email: email.trim(),
        source: "gitlab_primary",
      },
    });
  }
}

export class ConnectionPolicyError extends Error {
  readonly code = "CONNECTION_POLICY";
  readonly safeForClient = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ConnectionPolicyError";
  }
}
