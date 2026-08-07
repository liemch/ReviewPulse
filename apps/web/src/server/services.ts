/** Shared server wiring for AppAuth + GitLab settings + allowlists. */

import {
  AuditWriter,
  loadSessionPolicy,
  LocalPasswordAuthProvider,
  LockoutService,
  SessionService,
  UserAdminService,
  type SessionPolicy,
} from "@reviewpulse/app-auth";
import { prisma } from "@reviewpulse/db";
import {
  AllowlistAdminService,
  createDefaultCredentialProvider,
  DashboardQueryService,
  EmailAliasService,
  GitLabConnectionService,
  LiveProjectAccessService,
  MrMutationService,
  MrWorkspaceService,
} from "@reviewpulse/domain";

export type AppServices = {
  policy: SessionPolicy;
  sessions: SessionService;
  auth: LocalPasswordAuthProvider;
  users: UserAdminService;
  lockout: LockoutService;
  audit: AuditWriter;
  connections: GitLabConnectionService;
  projects: LiveProjectAccessService;
  allowlist: AllowlistAdminService;
  dashboard: DashboardQueryService;
  emails: EmailAliasService;
  mrWorkspace: MrWorkspaceService;
  mrMutations: MrMutationService;
};

let cached: AppServices | null = null;

export function getServices(
  env: Record<string, string | undefined> = process.env,
): AppServices {
  if (cached) {
    return cached;
  }
  const policy = loadSessionPolicy(env);
  const audit = new AuditWriter(prisma);
  const sessions = new SessionService(prisma, policy, audit);
  const lockout = new LockoutService(prisma, policy.sessionSecret);
  const auth = new LocalPasswordAuthProvider({
    prisma,
    sessions,
    lockout,
    audit,
    policy,
  });
  const users = new UserAdminService(prisma, sessions, audit);
  const credentials = createDefaultCredentialProvider(prisma);
  const connections = new GitLabConnectionService(prisma, credentials);
  const projects = new LiveProjectAccessService(prisma, credentials);
  const allowlist = new AllowlistAdminService(prisma);
  const dashboard = new DashboardQueryService(prisma, projects);
  const emails = new EmailAliasService(prisma);
  const mrWorkspace = new MrWorkspaceService(prisma, projects, credentials);
  const mrMutations = new MrMutationService(
    prisma,
    projects,
    credentials,
    audit,
  );

  cached = {
    policy,
    sessions,
    auth,
    users,
    lockout,
    audit,
    connections,
    projects,
    allowlist,
    dashboard,
    emails,
    mrWorkspace,
    mrMutations,
  };
  return cached;
}

/** Test helper. */
export function resetServicesForTests(): void {
  cached = null;
}
