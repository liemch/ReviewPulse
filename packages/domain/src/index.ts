/** WP0 stubs — no PAT/password deps. Implementations land in later WPs. */

export type ProjectRef = {
  gitlabInstanceId: string;
  gitlabProjectId: string;
};

export type SyncJobSpec = {
  jobType: string;
  gitlabInstanceId?: string;
  gitlabProjectId?: string;
};

export type SyncJob = SyncJobSpec & {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "sync_blocked";
};

export interface ProjectAccessService {
  authorizedProjectIds(userId: string): Promise<ProjectRef[]>;
}

export interface JobQueue {
  enqueue(job: SyncJobSpec): Promise<void>;
  claim(workerId: string): Promise<SyncJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, err: string, retryAt?: Date): Promise<void>;
}

export const PACKAGE_NAME = "@reviewpulse/domain" as const;
