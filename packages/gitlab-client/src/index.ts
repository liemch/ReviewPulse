/**
 * WP0 interface stub — GitLabReadClient + SSRF land in WP2.
 * M1 is read-only: no comment / approve / merge / mutation methods.
 */

export type GitLabUserIdentity = {
  id: number;
  username: string;
};

export interface GitLabReadClient {
  getCurrentUser(): Promise<GitLabUserIdentity>;
  // Future WP2: listCommits(since/until), listMergeRequests(updated_after), ...
}

export const PACKAGE_NAME = "@reviewpulse/gitlab-client" as const;
