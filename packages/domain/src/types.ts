export type ProjectRef = {
  gitlabInstanceId: string;
  gitlabProjectId: string;
};

export type SyncJobSpec = {
  jobType: "project_sync";
  gitlabInstanceId: string;
  gitlabProjectId: string;
  runAfter?: Date;
};

export type SyncJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "sync_blocked";

export type SyncJob = SyncJobSpec & {
  id: string;
  status: SyncJobStatus;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
};

export interface ProjectAccessService {
  authorizedProjectIds(userId: string): Promise<ProjectRef[]>;
}

export interface JobQueue {
  enqueue(job: SyncJobSpec): Promise<void>;
  claim(workerId: string): Promise<SyncJob | null>;
  complete(id: string, workerId: string): Promise<boolean>;
  fail(
    id: string,
    workerId: string,
    err: string,
    retryAt?: Date,
  ): Promise<boolean>;
  reschedule(
    id: string,
    workerId: string,
    runAfter?: Date,
  ): Promise<boolean>;
  syncBlocked(id: string, workerId: string, err?: string): Promise<boolean>;
  heartbeat(id: string, workerId: string, now?: Date): Promise<boolean>;
  recoverStaleClaims(now?: Date): Promise<number>;
}
