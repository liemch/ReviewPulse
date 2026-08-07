/**
 * WP7b — Weekly commit frequency (count only; no verdict).
 *
 * Assumptions (documented in KpiRule options_json until company locks):
 * - Timezone Asia/Ho_Chi_Minh; week starts Monday 00:00
 * - Dedupe by instance+project+SHA
 * - Exclude merge commits (title /^Merge /i) and bot authors (/bot/i)
 * - Include unmerged commits and reverts
 */

import type { MetricCommitInput } from "./types.js";

const MERGE_SUBJECT = /^Merge /i;
const BOT_AUTHOR = /bot/i;

export type CommitFrequencyOptions = {
  excludeMergeCommits?: boolean;
  excludeBotAuthors?: boolean;
};

export function isExcludedFromFrequency(
  commit: MetricCommitInput,
  options: CommitFrequencyOptions = {},
): boolean {
  const excludeMerge = options.excludeMergeCommits !== false;
  const excludeBot = options.excludeBotAuthors !== false;
  if (excludeMerge && commit.title !== null && MERGE_SUBJECT.test(commit.title)) {
    return true;
  }
  if (
    excludeBot &&
    commit.authorEmailNormalized !== null &&
    BOT_AUTHOR.test(commit.authorEmailNormalized)
  ) {
    return true;
  }
  return false;
}

/**
 * Count distinct SHAs authored in [windowStart, windowEnd).
 */
export function countCommitFrequency(
  commits: readonly MetricCommitInput[],
  windowStart: Date,
  windowEnd: Date,
  options: CommitFrequencyOptions = {},
): number {
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  const seen = new Set<string>();
  for (const commit of commits) {
    const at = commit.authoredAt.getTime();
    if (at < startMs || at >= endMs) {
      continue;
    }
    if (isExcludedFromFrequency(commit, options)) {
      continue;
    }
    const key = `${commit.gitlabInstanceId}\u0000${commit.gitlabProjectId}\u0000${commit.sha}`;
    seen.add(key);
  }
  return seen.size;
}

/**
 * Monday 00:00 Asia/Ho_Chi_Minh for the calendar week containing `now`.
 * Uses a fixed +07:00 offset (Vietnam does not observe DST).
 */
export function weekWindowAsiaHoChiMinh(now: Date = new Date()): {
  windowStart: Date;
  windowEnd: Date;
} {
  const OFFSET_MS = 7 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + OFFSET_MS);
  const day = local.getUTCDay(); // 0=Sun … 6=Sat in local wall clock via UTC fields
  const daysFromMonday = (day + 6) % 7;
  const mondayLocal = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() - daysFromMonday,
      0,
      0,
      0,
      0,
    ),
  );
  const windowStart = new Date(mondayLocal.getTime() - OFFSET_MS);
  const windowEnd = new Date(windowStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { windowStart, windowEnd };
}
