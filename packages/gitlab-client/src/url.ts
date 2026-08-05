/**
 * Base URL normalization and exact canonical-origin allowlist matching (A1/A3).
 *
 * Everything downstream compares canonical origins, never raw user input, so
 * `HTTPS://GitLab.Example.com:443/` and `https://gitlab.example.com` are one
 * entry, while `https://evil.gitlab.example.com` is a different one. Matching
 * is equality only — no suffix or parent-domain logic, ever.
 */

import { GitLabInvalidConfigError } from "./errors.js";

export type GitLabAllowlistEntry = {
  /** Canonical origin, e.g. `https://gitlab.example.com` or `...:8443`. */
  readonly origin: string;
  /**
   * Opt-in for RFC1918 / ULA / CGNAT destinations. Loopback, link-local, and
   * metadata addresses stay denied even when this is true.
   */
  readonly internal: boolean;
};

export type GitLabAllowlist = {
  readonly entries: readonly GitLabAllowlistEntry[];
  find(origin: string): GitLabAllowlistEntry | null;
};

export type NormalizeOptions = {
  /** Outside tests, plaintext HTTP to a GitLab instance is a configuration bug. */
  readonly requireHttps?: boolean;
};

const DEFAULT_PORTS: Record<string, string> = {
  "https:": "443",
  "http:": "80",
};

/**
 * Normalizes an operator-supplied base URL into a canonical origin.
 *
 * Rejects: empty input, non-http(s) schemes, userinfo, a path/query/fragment
 * on the instance base, and http when https is required.
 */
export function normalizeGitLabBaseUrl(
  input: string,
  options: NormalizeOptions = {},
): string {
  const requireHttps = options.requireHttps ?? true;

  if (typeof input !== "string") {
    throw new GitLabInvalidConfigError({ reason: "not_a_string" });
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new GitLabInvalidConfigError({ reason: "empty" });
  }
  // A bare host would be parsed as a scheme-less relative URL by `new URL`.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw new GitLabInvalidConfigError({ reason: "missing_scheme" });
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GitLabInvalidConfigError({ reason: "unparseable" });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GitLabInvalidConfigError({ reason: "unsupported_scheme" });
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new GitLabInvalidConfigError({ reason: "https_required" });
  }
  if (url.username !== "" || url.password !== "") {
    throw new GitLabInvalidConfigError({ reason: "userinfo_not_allowed" });
  }
  if (url.hostname === "") {
    throw new GitLabInvalidConfigError({ reason: "empty_host" });
  }
  if (url.search !== "" || url.hash !== "") {
    throw new GitLabInvalidConfigError({ reason: "query_or_fragment" });
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    // GitLab under a sub-path is not supported in M1; allowing it would make
    // the allowlist a prefix match rather than an origin match.
    throw new GitLabInvalidConfigError({ reason: "path_not_allowed" });
  }

  const hostname = url.hostname.toLowerCase();
  const defaultPort = DEFAULT_PORTS[url.protocol];
  const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;

  return `${url.protocol}//${hostname}${port}`;
}

/**
 * Parses `GITLAB_URL_ALLOWLIST`. Entries are comma- or whitespace-separated.
 * An `internal:` prefix opts that origin into RFC1918/ULA destinations.
 */
export function parseAllowlistEnv(
  raw: string | undefined,
  options: NormalizeOptions = {},
): GitLabAllowlist {
  const tokens = (raw ?? "")
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return createGitLabAllowlist(
    tokens.map((token) =>
      token.toLowerCase().startsWith("internal:")
        ? { url: token.slice("internal:".length), internal: true }
        : { url: token, internal: false },
    ),
    options,
  );
}

export function createGitLabAllowlist(
  entries: ReadonlyArray<string | { url: string; internal?: boolean }>,
  options: NormalizeOptions = {},
): GitLabAllowlist {
  const byOrigin = new Map<string, GitLabAllowlistEntry>();

  for (const entry of entries) {
    const url = typeof entry === "string" ? entry : entry.url;
    const internal = typeof entry === "string" ? false : (entry.internal ?? false);
    const origin = normalizeGitLabBaseUrl(url, options);
    const existing = byOrigin.get(origin);
    byOrigin.set(origin, {
      origin,
      // Duplicate entries widen rather than silently drop the internal opt-in.
      internal: internal || (existing?.internal ?? false),
    });
  }

  const list = [...byOrigin.values()];
  return {
    entries: list,
    find(origin: string): GitLabAllowlistEntry | null {
      return byOrigin.get(origin) ?? null;
    },
  };
}

export type QueryValue = string | number | boolean | undefined;

/**
 * Joins an API path onto a canonical origin and re-verifies the result.
 *
 * The path is treated as opaque data, not as a URL: a caller-supplied
 * `//evil.example.com/x` or `\\evil` cannot re-point the request, because the
 * origin of the built URL is compared back to the origin it was built from.
 */
export function buildApiUrl(
  origin: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> = {},
): URL {
  if (!path.startsWith("/api/v4/") && path !== "/api/v4") {
    throw new GitLabInvalidConfigError({ reason: "path_outside_api_v4" });
  }
  if (path.includes("\\") || path.includes("//") || path.includes("@")) {
    throw new GitLabInvalidConfigError({ reason: "suspicious_path" });
  }

  const base = new URL(origin);
  const url = new URL(base);
  url.pathname = path;

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  if (url.origin !== base.origin) {
    throw new GitLabInvalidConfigError({ reason: "origin_escape" });
  }
  return url;
}

/** GitLab accepts either a numeric id or a URL-encoded `group/project` path. */
export function encodeProjectId(projectId: number | string): string {
  if (typeof projectId === "number") {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      throw new GitLabInvalidConfigError({ reason: "invalid_project_id" });
    }
    return String(projectId);
  }
  const trimmed = projectId.trim();
  if (trimmed.length === 0) {
    throw new GitLabInvalidConfigError({ reason: "invalid_project_id" });
  }
  return encodeURIComponent(trimmed);
}

/** Canonical origin of an arbitrary URL, for same-origin pagination checks. */
export function originOf(url: URL): string {
  const defaultPort = DEFAULT_PORTS[url.protocol];
  const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}
