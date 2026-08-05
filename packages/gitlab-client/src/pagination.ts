/**
 * Offset pagination over GitLab's `Link` / `X-Next-Page` headers.
 *
 * The next-page target is attacker-influenceable — it comes from a response
 * header — so it is validated as same-origin before it is turned into a
 * cursor, and only the page numbers are carried forward. We never follow the
 * header URL verbatim.
 */

import {
  GitLabMalformedResponseError,
  GitLabPaginationLimitError,
  GitLabSsrfBlockedError,
} from "./errors.js";
import type { ClientLimits } from "./limits.js";
import { originOf } from "./url.js";

export type GitLabPageCursor = {
  readonly page: number;
  readonly perPage: number;
};

export type Page<T> = {
  readonly items: T[];
  /** Opaque resume token. Callers must not synthesize their own. */
  readonly nextPage: GitLabPageCursor | null;
};

/** `<https://host/api/v4/x?page=2>; rel="next", <...>; rel="last"` */
export function parseLinkHeader(
  value: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === undefined || value.trim().length === 0) {
    return out;
  }

  for (const section of value.split(",")) {
    const trimmed = section.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^<([^>]*)>\s*;\s*(.+)$/.exec(trimmed);
    if (match === null) {
      throw new GitLabMalformedResponseError({ reason: "bad_link_header" });
    }
    const [, target = "", params = ""] = match;
    const relMatch = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/i.exec(params);
    if (relMatch === null) {
      continue;
    }
    const rel = relMatch[1]?.trim().toLowerCase();
    if (rel !== undefined && rel.length > 0 && !(rel in out)) {
      out[rel] = target.trim();
    }
  }
  return out;
}

export type NextCursorContext = {
  readonly headers: Readonly<Record<string, string>>;
  readonly expectedOrigin: string;
  readonly current: GitLabPageCursor;
};

/**
 * Returns the next cursor, or null when the list is exhausted.
 * Throws `GitLabSsrfBlockedError` if GitLab points us at another origin.
 */
export function parseNextCursor(
  context: NextCursorContext,
): GitLabPageCursor | null {
  const links = parseLinkHeader(context.headers["link"]);
  const next = links["next"];

  if (next !== undefined && next.length > 0) {
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      throw new GitLabMalformedResponseError({ reason: "bad_link_target" });
    }
    if (originOf(url) !== context.expectedOrigin) {
      throw new GitLabSsrfBlockedError({ reason: "cross_origin_pagination" });
    }
    const page = toPositiveInt(url.searchParams.get("page"));
    const perPage =
      toPositiveInt(url.searchParams.get("per_page")) ?? context.current.perPage;
    if (page === null) {
      throw new GitLabMalformedResponseError({ reason: "bad_link_page" });
    }
    return { page, perPage };
  }

  const headerPage = toPositiveInt(context.headers["x-next-page"]);
  if (headerPage === null) {
    return null;
  }
  const headerPerPage =
    toPositiveInt(context.headers["x-per-page"]) ?? context.current.perPage;
  return { page: headerPage, perPage: headerPerPage };
}

function toPositiveInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : null;
}

export type PaginationBounds = Pick<
  ClientLimits,
  "maxPages" | "maxItems" | "perPage"
>;

/**
 * Walks every page of a list endpoint under hard bounds.
 *
 * Cycle detection matters because the cursor comes from the server: a GitLab
 * (or proxy) that keeps answering `rel=next -> page=2` would otherwise spin
 * forever, and `maxPages` alone would still cost 100 requests.
 */
export async function drainPages<T>(
  fetchPage: (cursor: GitLabPageCursor) => Promise<Page<T>>,
  bounds: PaginationBounds,
  start?: GitLabPageCursor,
): Promise<T[]> {
  const first: GitLabPageCursor = start ?? {
    page: 1,
    perPage: bounds.perPage,
  };

  const items: T[] = [];
  const visited = new Set<string>();
  let cursor: GitLabPageCursor | null = first;
  let pages = 0;

  while (cursor !== null) {
    const key = `${cursor.page}:${cursor.perPage}`;
    if (visited.has(key)) {
      throw new GitLabPaginationLimitError({ reason: "cursor_cycle" });
    }
    visited.add(key);

    pages += 1;
    if (pages > bounds.maxPages) {
      throw new GitLabPaginationLimitError({ reason: "max_pages" });
    }

    const page: Page<T> = await fetchPage(cursor);
    items.push(...page.items);
    if (items.length > bounds.maxItems) {
      throw new GitLabPaginationLimitError({ reason: "max_items" });
    }
    cursor = page.nextPage;
  }

  return items;
}
