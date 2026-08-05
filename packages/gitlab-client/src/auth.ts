/**
 * Injectable credential source (A4).
 *
 * The adapter yields a credential; the HTTP layer — not the adapter — decides
 * which header carries it (A5). That keeps "PAT goes in PRIVATE-TOKEN, never
 * in a URL" a single enforced rule instead of something each caller re-derives.
 *
 * This package never talks to Prisma. Callers resolve the PAT through
 * `@reviewpulse/credentials` and hand the plaintext in for the call's duration.
 */

import { GitLabInvalidConfigError } from "./errors.js";

export type GitLabAccessToken = string;

export type GitLabCredential = {
  readonly kind: "pat";
  readonly token: GitLabAccessToken;
};

export type TokenProvider = {
  getAccessToken(): Promise<GitLabAccessToken> | GitLabAccessToken;
};

export interface GitLabAuthAdapter {
  getCredential(signal?: AbortSignal): Promise<GitLabCredential>;
}

export const PRIVATE_TOKEN_HEADER = "private-token" as const;

function isTokenProvider(value: unknown): value is TokenProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TokenProvider).getAccessToken === "function"
  );
}

/**
 * Throws on a blank token rather than sending an empty `PRIVATE-TOKEN`, which
 * GitLab would answer with a 401 that looks like a revoked credential.
 */
export function createPatAuthAdapter(
  source:
    | TokenProvider
    | (() => Promise<GitLabAccessToken> | GitLabAccessToken),
): GitLabAuthAdapter {
  const read = isTokenProvider(source)
    ? () => source.getAccessToken()
    : () => source();

  return {
    async getCredential(): Promise<GitLabCredential> {
      const token = await read();
      if (typeof token !== "string" || token.length === 0) {
        throw new GitLabInvalidConfigError({ reason: "empty_access_token" });
      }
      return { kind: "pat", token };
    },
  };
}
