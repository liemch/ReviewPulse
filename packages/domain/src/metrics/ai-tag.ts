/**
 * WP7b — AI-assisted commit detection via bracketed [AI] / [ai] subject tag.
 */

import type { MetricCommitInput } from "./types.js";

/** Case-insensitive bracketed AI tag in the commit subject (title). */
export const AI_TAG_SUBJECT_REGEX = /\[[Aa][Ii]\]/;

export function subjectHasAiTag(title: string | null | undefined): boolean {
  if (title === null || title === undefined || title.length === 0) {
    return false;
  }
  return AI_TAG_SUBJECT_REGEX.test(title);
}

/**
 * Count distinct SHAs (per instance+project) whose subject contains [AI].
 * Absence of the tag does not mean "did not use AI".
 */
export function countAiAssistedCommits(
  commits: readonly MetricCommitInput[],
): number {
  const seen = new Set<string>();
  for (const commit of commits) {
    if (!subjectHasAiTag(commit.title)) {
      continue;
    }
    const key = `${commit.gitlabInstanceId}\u0000${commit.gitlabProjectId}\u0000${commit.sha}`;
    seen.add(key);
  }
  return seen.size;
}
