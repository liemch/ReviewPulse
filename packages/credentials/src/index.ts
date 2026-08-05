/** WP0 interface stub — PatCredentialProvider lands in WP1. */

export type CredentialInvalidReason = "revoked" | "expired" | "user_deleted";

export interface GitLabCredentialProvider {
  getAccessToken(userId: string, instanceId: string): Promise<string>;
  invalidateCredential(
    userId: string,
    instanceId: string,
    reason: CredentialInvalidReason,
  ): Promise<void>;
}

export const PACKAGE_NAME = "@reviewpulse/credentials" as const;
