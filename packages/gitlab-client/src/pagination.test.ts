import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GitLabMalformedResponseError,
  GitLabPaginationLimitError,
  GitLabSsrfBlockedError,
} from "./errors.js";
import {
  drainPages,
  parseLinkHeader,
  parseNextCursor,
  type GitLabPageCursor,
  type Page,
} from "./pagination.js";

const ORIGIN = "https://gitlab.example.com";
const CURRENT: GitLabPageCursor = { page: 1, perPage: 100 };

describe("parseLinkHeader", () => {
  it("extracts every rel target", () => {
    const links = parseLinkHeader(
      `<${ORIGIN}/api/v4/projects?page=2&per_page=100>; rel="next", ` +
        `<${ORIGIN}/api/v4/projects?page=9&per_page=100>; rel="last"`,
    );
    assert.equal(links["next"], `${ORIGIN}/api/v4/projects?page=2&per_page=100`);
    assert.equal(links["last"], `${ORIGIN}/api/v4/projects?page=9&per_page=100`);
  });

  it("returns nothing for an absent or empty header", () => {
    assert.deepEqual(parseLinkHeader(undefined), {});
    assert.deepEqual(parseLinkHeader("   "), {});
  });

  it("rejects a header it cannot parse rather than guessing", () => {
    assert.throws(
      () => parseLinkHeader("not-a-link-header"),
      GitLabMalformedResponseError,
    );
  });
});

describe("parseNextCursor", () => {
  it("reads the cursor from rel=next", () => {
    const next = parseNextCursor({
      headers: {
        link: `<${ORIGIN}/api/v4/projects?page=3&per_page=50>; rel="next"`,
      },
      expectedOrigin: ORIGIN,
      current: CURRENT,
    });
    assert.deepEqual(next, { page: 3, perPage: 50 });
  });

  it("falls back to X-Next-Page", () => {
    const next = parseNextCursor({
      headers: { "x-next-page": "4", "x-per-page": "20" },
      expectedOrigin: ORIGIN,
      current: CURRENT,
    });
    assert.deepEqual(next, { page: 4, perPage: 20 });
  });

  it("keeps the current perPage when the response omits it", () => {
    const next = parseNextCursor({
      headers: { "x-next-page": "2" },
      expectedOrigin: ORIGIN,
      current: CURRENT,
    });
    assert.deepEqual(next, { page: 2, perPage: 100 });
  });

  it("reports exhaustion for an empty X-Next-Page or no headers", () => {
    assert.equal(
      parseNextCursor({
        headers: { "x-next-page": "" },
        expectedOrigin: ORIGIN,
        current: CURRENT,
      }),
      null,
    );
    assert.equal(
      parseNextCursor({ headers: {}, expectedOrigin: ORIGIN, current: CURRENT }),
      null,
    );
  });

  it("blocks a cross-origin next link instead of following it", () => {
    assert.throws(
      () =>
        parseNextCursor({
          headers: {
            link: `<https://evil.example.com/api/v4/projects?page=2>; rel="next"`,
          },
          expectedOrigin: ORIGIN,
          current: CURRENT,
        }),
      (error: unknown) => {
        assert.ok(error instanceof GitLabSsrfBlockedError);
        assert.equal(error.context["reason"], "cross_origin_pagination");
        return true;
      },
    );
  });

  it("blocks a next link that only differs by port", () => {
    assert.throws(
      () =>
        parseNextCursor({
          headers: {
            link: `<${ORIGIN}:8443/api/v4/projects?page=2>; rel="next"`,
          },
          expectedOrigin: ORIGIN,
          current: CURRENT,
        }),
      GitLabSsrfBlockedError,
    );
  });

  it("rejects a next link with no usable page number", () => {
    assert.throws(
      () =>
        parseNextCursor({
          headers: { link: `<${ORIGIN}/api/v4/projects>; rel="next"` },
          expectedOrigin: ORIGIN,
          current: CURRENT,
        }),
      GitLabMalformedResponseError,
    );
  });
});

describe("drainPages", () => {
  const bounds = { perPage: 2, maxPages: 5, maxItems: 100 };

  it("concatenates pages until the cursor is exhausted", async () => {
    const pages: Record<number, Page<number>> = {
      1: { items: [1, 2], nextPage: { page: 2, perPage: 2 } },
      2: { items: [3, 4], nextPage: { page: 3, perPage: 2 } },
      3: { items: [5], nextPage: null },
    };
    const items = await drainPages<number>(
      async (cursor) => pages[cursor.page] ?? { items: [], nextPage: null },
      bounds,
    );
    assert.deepEqual(items, [1, 2, 3, 4, 5]);
  });

  it("detects a server that keeps pointing at the same page", async () => {
    await assert.rejects(
      () =>
        drainPages<number>(
          async () => ({ items: [1], nextPage: { page: 1, perPage: 2 } }),
          bounds,
        ),
      (error: unknown) => {
        assert.ok(error instanceof GitLabPaginationLimitError);
        assert.equal(error.context["reason"], "cursor_cycle");
        return true;
      },
    );
  });

  it("stops at maxPages", async () => {
    let fetched = 0;
    await assert.rejects(
      () =>
        drainPages<number>(
          async (cursor) => {
            fetched += 1;
            return { items: [cursor.page], nextPage: { page: cursor.page + 1, perPage: 2 } };
          },
          { perPage: 2, maxPages: 3, maxItems: 100 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof GitLabPaginationLimitError);
        assert.equal(error.context["reason"], "max_pages");
        return true;
      },
    );
    assert.equal(fetched, 3);
  });

  it("stops at maxItems", async () => {
    await assert.rejects(
      () =>
        drainPages<number>(
          async (cursor) => ({
            items: [1, 2, 3],
            nextPage: { page: cursor.page + 1, perPage: 2 },
          }),
          { perPage: 2, maxPages: 50, maxItems: 5 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof GitLabPaginationLimitError);
        assert.equal(error.context["reason"], "max_items");
        return true;
      },
    );
  });
});
