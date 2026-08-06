# WP2 Execution Plan — GitLab read client + SSRF

Status: **PASS** — 2026-08-05 (merged to main via PR #4; CI green)  
Parent: `docs/PLAN-M1-Implementation.md` (APPROVED)  
Prerequisite: **WP1 = PASS**  
Branch: `feat/m1-wp2-gitlab-read-client` (merged)

Scope was the read-only HTTP client and SSRF/egress hardening only.

**Out of scope (hard):**
- AppAuth / session / CSRF / login / UI
- GitLab Settings UI (add/test/replace PAT) — WP3b
- Sync worker / job queue / coalesce — WP6
- Membership cache / ProjectAccess / dashboard — WP5 / WP7
- OAuth / SSO / Redis / webhook
- AI / NVIDIA
- Any GitLab mutation (comment / approve / merge / note / create / update / delete)
- Clearing TB-WP0 backlog unless separately approved

---

## 0. Approved decisions (A1–A8, locked)

| ID | Topic | **Locked decision** |
|---|---|---|
| **A1** | Egress / SSRF policy | **Exact canonical-origin allowlist.** RFC1918 / ULA permitted **only** for an internal host whose canonical origin is exact-allowlisted. Loopback, link-local, and cloud-metadata addresses are **always** denied, allowlisted or not. **Every** DNS answer must validate — one denied address fails the whole request. The socket is **pinned to a validated IP**, while the original hostname is kept for TLS SNI / `Host`. Redirects = 0. TLS verification is **never** disabled. |
| **A2** | Redirect policy | **Follow 0 redirects** — any `3xx` fails closed. |
| **A3** | Allowlist input | Client receives a pre-validated `GitLabInstanceContext` (canonical origin + instance id). Allowlist matching is a pure exported helper; the client does not read env at request time. |
| **A4** | Credential acquisition | Injectable `GitLabAuthAdapter`; no Prisma dependency in `gitlab-client`. |
| **A5** | Auth header | **`PRIVATE-TOKEN: <pat>`** only. Never in the URL. No `Authorization: Bearer` in M1. |
| **A6** | Commit surface | `listCommits(projectId, { since, until, refName? })` + `listBranches(projectId)`; multi-branch watermark orchestration stays WP6. |
| **A7** | Response size cap | **8 MiB** per response body (per page). Exceeding it aborts the stream and throws. |
| **A8** | Retry & time budget | Max **4 attempts including the first**. **15 s per attempt**, **45 s total per page request**. Exponential backoff + full jitter, delay capped at **8 s**. `Retry-After` is honored **only within the remaining total budget** — if the wait would exceed it, fail immediately instead of sleeping. **Caller abort stops everything at once**, with no further attempt or sleep. |

**Pagination (locked):** same-origin only — a `Link`/`X-Next-Page` target on a different origin is rejected, never followed. Bounded by `maxPages` and `maxItems`, with cycle detection on visited page URLs. Each page body is subject to the same 8 MiB cap.

**Pagination defaults (locked):** `perPage = 100` (GitLab max), `maxPages = 100`, `maxItems = 10_000`. One drain therefore reads at most 100 pages × 100 items, matching `maxItems`, and cannot silently pull an unbounded repository history.

Items locked by the parent plan: D4 (401 ≠ 403/404), D5 (commits `since`/`until`; MRs `updated_after`), read-only M1, HTTPS in deploy.

---

## 1. Public API — `GitLabReadClient` (proposed)

Package: `@reviewpulse/gitlab-client`

```ts
/** Opaque per-request / per-connection GitLab context. No secrets in toString/logs. */
export type GitLabInstanceContext = {
  instanceId: string;          // ReviewPulse allowlist row id (or stable key)
  baseUrlNormalized: string;   // see §4 — no trailing slash, https only in deploy
};

export type GitLabAccessToken = string; // never logged; pass only in memory

export type TokenProvider = {
  /** Returns plaintext PAT for this call; must not cache across requests in WP2. */
  getAccessToken(): Promise<GitLabAccessToken>;
};

/** A4: injectable credential source. The client — not the adapter — chooses the header (A5). */
export type GitLabCredential = { readonly kind: "pat"; readonly token: GitLabAccessToken };

export interface GitLabAuthAdapter {
  getCredential(signal?: AbortSignal): Promise<GitLabCredential>;
}

/** M1 adapter: wraps a TokenProvider / thunk; the client sends it as `PRIVATE-TOKEN`. */
export function createPatAuthAdapter(
  source: TokenProvider | (() => Promise<GitLabAccessToken> | GitLabAccessToken),
): GitLabAuthAdapter;

export type GitLabUser = {
  id: number;
  username: string;
  name: string | null;
  // primary email if GitLab returns it; may be null when private
  email: string | null;
};

export type GitLabProjectRef = {
  id: number;
  pathWithNamespace: string;
  name: string;
  archived: boolean;
  defaultBranch: string | null;
  webUrl: string | null;
  lastActivityAt: string | null; // ISO-8601 from GitLab
};

export type GitLabCommit = {
  id: string;          // full SHA
  shortId: string;
  title: string;
  message: string;
  authorName: string | null;
  authorEmail: string | null;
  authoredDate: string; // ISO-8601
  webUrl: string | null;
};

export type GitLabMergeRequest = {
  iid: number;
  projectId: number;
  title: string;
  state: string;
  authorUsername: string | null;
  // GitLab MR payloads often omit author email; keep null when absent
  authorEmail: string | null;
  updatedAt: string;   // ISO-8601
  webUrl: string | null;
  sha: string | null;  // head SHA when present
};

export type Page<T> = {
  items: T[];
  /** Opaque resume token for the next page; null when exhausted. */
  nextPage: GitLabPageCursor | null;
};

export type GitLabPageCursor = {
  page: number;
  perPage: number;
};

export type ListCommitsQuery = {
  since: Date;           // authored lower bound (inclusive per GitLab)
  until: Date;           // authored upper bound
  refName?: string;      // branch/tag; omit = GitLab default behavior
  page?: GitLabPageCursor;
};

export type ListMergeRequestsQuery = {
  updatedAfter: Date;    // maps to updated_after
  state?: "opened" | "closed" | "merged" | "all";
  page?: GitLabPageCursor;
};

export interface GitLabReadClient {
  getCurrentUser(): Promise<GitLabUser>;

  /** Projects the PAT can see (membership); caller intersects with ReviewPulse allowlist later (WP4). */
  listAccessibleProjects(page?: GitLabPageCursor): Promise<Page<GitLabProjectRef>>;

  getProject(projectId: number | string): Promise<GitLabProjectRef>;

  listBranches(
    projectId: number | string,
    page?: GitLabPageCursor,
  ): Promise<Page<{ name: string; merged: boolean; protected: boolean; default: boolean }>>;

  listCommits(
    projectId: number | string,
    query: ListCommitsQuery,
  ): Promise<Page<GitLabCommit>>;

  listMergeRequests(
    projectId: number | string,
    query: ListMergeRequestsQuery,
  ): Promise<Page<GitLabMergeRequest>>;
}
```

**Factory (proposed):**

```ts
createGitLabReadClient(deps: {
  instance: GitLabInstanceContext;
  auth: GitLabAuthAdapter;
  ssrf?: SsrfGuard;                 // allowlist + private-IP rules from §5
  transport?: GitLabHttpTransport;  // injectable for tests; defaults to pinned node:https
  limits?: Partial<ClientLimits>;   // timeout / size / retry / pagination overrides
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; // fake timers in tests
  random?: () => number;            // deterministic jitter in tests
}): GitLabReadClient;
```

**Not exported:** any method that would issue `POST` / `PUT` / `PATCH` / `DELETE`. No `create*`, `update*`, `delete*`, `approve*`, `merge*`, `comment*`, `note*`.

---

## 2. Minimal request/response mapping

| Client method | HTTP | GitLab path | Query / notes |
|---|---|---|---|
| `getCurrentUser` | `GET` | `/api/v4/user` | — |
| `listAccessibleProjects` | `GET` | `/api/v4/projects` | `membership=true`, `simple=true`, `per_page`, `page`, `order_by=last_activity_at` |
| `getProject` | `GET` | `/api/v4/projects/:id` | URL-encode path ids (`group%2Fproj`) |
| `listBranches` | `GET` | `/api/v4/projects/:id/repository/branches` | `per_page`, `page` |
| `listCommits` | `GET` | `/api/v4/projects/:id/repository/commits` | `since`, `until` (ISO-8601), optional `ref_name`, `per_page`, `page` — **never** `updated_after` |
| `listMergeRequests` | `GET` | `/api/v4/projects/:id/merge_requests` | `updated_after` (ISO-8601), optional `state`, `per_page`, `page` |

Response DTOs are mapped into the types above; unknown extra JSON fields are ignored. Required fields missing → `GitLabMalformedResponseError`.

---

## 3. PAT header strategy (proposed lock)

1. Send exactly one auth header: `PRIVATE-TOKEN: <pat>`.
2. **Forbidden:** `private_token` / `access_token` query params; Authorization header in M1; logging the header value.
3. Token obtained via `GitLabAuthAdapter.getCredential()` immediately before each attempt; the client keeps no cross-request cache.
4. On typed `GitLabUnauthorizedError` (401), client **does not** call `invalidateCredential` itself (avoids WP1 P1 stale-invalidate footgun). Callers decide invalidation (WP3b / WP6), preferably scoped to the credential id that produced the token.
5. Redact via `@reviewpulse/crypto` `redact` / `redactHeaders` before any log of headers or error context.

---

## 4. URL normalization & allowlist matching (proposed)

**Normalize `baseUrl` → `baseUrlNormalized`:**

1. Trim; reject empty.
2. Parse with `URL` (WHATWG). Reject non-`http:` / non-`https:` schemes. **Deploy/prod:** require `https:` (config flag `requireHttps: true` default true outside test).
3. Reject userinfo (`user:pass@host`).
4. Hostname: lowercase ASCII; reject empty host.
5. Drop default ports (`:443` for https, `:80` for http); keep explicit non-default ports.
6. Path: strip trailing `/`; no query/hash allowed on instance base.
7. Result form: `https://gitlab.example.com` or `https://gitlab.example.com:8443`.

**Allowlist match (exact):**

- Compare **normalized** strings for equality only (no suffix / parent-domain match).
- `https://gitlab.example.com` does **not** match `https://evil.gitlab.example.com`.
- IP literals in allowlist are permitted only under policy A1 (see §5).

---

## 5. SSRF / internal GitLab policy (LOCKED — A1/A2)

### 5.1 Exact admin allowlist

- Only hosts (or host:port) present on the allowlist may be contacted.
- Request URL must be `baseUrlNormalized + "/api/v4/..."`.
- Path may not contain `\\`, scheme-relative `//`, or `@` authority tricks after join; use `new URL(path, base)` and re-validate hostname ≡ allowlisted host.

### 5.2 When private addresses are allowed (A1 locked)

| Destination class | Default |
|---|---|
| Loopback (`127.0.0.0/8`, `::1`) | **Deny** always |
| Link-local (`169.254.0.0/16`, `fe80::/10`) | **Deny** always |
| Cloud metadata (`169.254.169.254`, `fd00:ec2::254`, etc.) | **Deny** always |
| RFC1918 / ULA (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), CGNAT `100.64/10` | **Allow iff** the canonical origin is exact-allowlisted **and** marked `internal` **and** DNS resolution is pinned (below) |
| IPv4-mapped IPv6 (`::ffff:a.b.c.d`) | Unwrap, then classify as the embedded IPv4 |
| Unspecified (`0.0.0.0`, `::`), broadcast, multicast, reserved | **Deny** always |
| Public unicast | Allow iff canonical origin is exact-allowlisted |

Rationale: self-hosted GitLab is commonly on RFC1918; blanket deny breaks the product. Open browsing of private IPs remains forbidden — an allowlist entry must opt in via `internal: true`.

### 5.3 DNS rebinding & pin

For every connection attempt:

1. Resolve hostname → address list via explicit resolver (Node `dns.promises.lookup` with `all: true`, or injectable resolver in tests). An IP-literal host skips DNS and is classified directly.
2. Classify **every** address; if **any** address is denied by §5.2 → **fail closed** (`GitLabSsrfBlockedError`). No "first good answer wins".
3. Empty answer → fail closed.
4. Connect to the **first validated address only**, pinned: `node:https`/`node:http` request with a custom `lookup` returning the pinned IP, `servername` = original hostname (TLS SNI), `Host` header = original host. TLS verification stays on (`rejectUnauthorized` untouched).
5. **Re-resolve before redirects** — moot under A2 (0 redirects).

### 5.4 Redirects (A2 locked)

- Treat any `3xx` with `Location` as **failure** (`GitLabRedirectRejectedError`).
- Do not follow. Prevents redirect-based SSRF to metadata.

### 5.5 Fail closed

On DNS failure, empty answer, mixed public+private answers when policy forbids, timeout during resolve, or classification error → do not send the HTTP request; throw typed SSRF/network error without echoing the PAT.

---

## 6. Pagination (GitLab Link / headers)

- Default `per_page=100` (GitLab max), `maxPages=100`, `maxItems=10_000`.
- Prefer parsing `Link` response header for `rel="next"`; also accept `X-Next-Page` when present.
- **Same-origin only:** the `rel="next"` URL is parsed and its origin compared to the instance canonical origin. A cross-origin next link is **rejected** (`GitLabSsrfBlockedError`), never followed.
- Client returns `Page<T>` with `nextPage: { page, perPage } | null`.
- Callers iterate; WP2 does **not** auto-drain unbounded lists in one call (prevents silent mega-downloads). `drainPages()` is provided for callers/tests and enforces `maxPages`, `maxItems`, and **cycle detection** over visited `(page, perPage)` cursors; exceeding a bound throws `GitLabPaginationLimitError`. Every page body stays under the 8 MiB cap.
- Cursor opacity: callers must not invent page numbers from totals; only use returned `nextPage`.

---

## 7. Retry policy (LOCKED — A8)

| Status | Retry? |
|---|---|
| 429 | Yes |
| 502, 503, 504 | Yes |
| 408 | Yes (if ever returned) |
| 401, 403, 404, 400, 422 | **No** |
| Other 4xx | **No** |
| Network reset / DNS after request start | Yes (count toward attempts) |
| SSRF / redirect reject / malformed | **No** |

**Budget (A8 locked):**
- **4 attempts maximum, counting the first.**
- **15 s per attempt** (per-attempt deadline).
- **45 s total per page request**, measured from the first attempt across retries and sleeps.
- Caller abort wins immediately: no further attempt, no remaining sleep.

**Delay:**
1. If `Retry-After` is a delta-seconds integer → wait that many seconds.
2. If `Retry-After` is an HTTP-date → wait until that time.
3. Else `delay = min(8000, 250 * 2^(attempt-1))` ms with full jitter `U(0, delay)`.
4. **Any** computed delay is honored only if it fits in the **remaining total budget**; otherwise fail immediately rather than sleeping into a guaranteed timeout.

After the budget is exhausted → `GitLabRateLimitedError` (if the last response was 429) or `GitLabUpstreamUnavailableError`.

Idempotency: all WP2 methods are GET → safe to retry.

---

## 8. Timeout, abort, response size (LOCKED — A7/A8)

| Limit | Default |
|---|---|
| Connect + headers + body per attempt | **15s** (A8) |
| Total per page request (all attempts + sleeps) | **45s** (A8) |
| Caller cancellation | Accept optional `AbortSignal`; abort → `GitLabTimeoutError` or `GitLabAbortedError` |
| Max response body | **8 MiB** (A7); stream/count bytes; exceed → abort + `GitLabResponseTooLargeError` |
| Max redirects | **0** (A2) |

Partial bodies are discarded; never return truncated JSON as success.

---

## 9. Error taxonomy (proposed)

All errors: typed `code` + fixed safe `message` + `safeForClient: true` where appropriate. **Never** interpolate PAT, `PRIVATE-TOKEN`, raw body dumps, or full URLs with secrets.

| Error class | `code` | When |
|---|---|---|
| `GitLabUnauthorizedError` | `GITLAB_UNAUTHORIZED` | HTTP 401 |
| `GitLabProjectForbiddenError` | `GITLAB_PROJECT_FORBIDDEN` | HTTP 403 on project-scoped route |
| `GitLabProjectNotFoundError` | `GITLAB_PROJECT_NOT_FOUND` | HTTP 404 on project-scoped route |
| `GitLabRateLimitedError` | `GITLAB_RATE_LIMITED` | 429 after retries exhausted (include optional `retryAfterMs` metadata, not secret) |
| `GitLabTimeoutError` | `GITLAB_TIMEOUT` | wall-clock / abort timeout |
| `GitLabAbortedError` | `GITLAB_ABORTED` | caller abort |
| `GitLabUpstreamUnavailableError` | `GITLAB_UPSTREAM_UNAVAILABLE` | 5xx after retries / transport failure |
| `GitLabMalformedResponseError` | `GITLAB_MALFORMED_RESPONSE` | non-JSON, schema miss, bad Link header |
| `GitLabResponseTooLargeError` | `GITLAB_RESPONSE_TOO_LARGE` | over size cap |
| `GitLabSsrfBlockedError` | `GITLAB_SSRF_BLOCKED` | allowlist / IP / DNS policy |
| `GitLabRedirectRejectedError` | `GITLAB_REDIRECT_REJECTED` | any 3xx |
| `GitLabPaginationLimitError` | `GITLAB_PAGINATION_LIMIT` | maxPages / maxItems exceeded, or page-cursor cycle detected |
| `GitLabForbiddenError` | `GITLAB_FORBIDDEN` | 403 on a non-project route |
| `GitLabNotFoundError` | `GITLAB_NOT_FOUND` | 404 on a non-project route |
| `GitLabInvalidConfigError` | `GITLAB_INVALID_CONFIG` | bad base URL normalization |

**401 vs 403/404 (D4):** project-scoped 403/404 **must not** be mapped to unauthorized. Non-project routes (e.g. `/user`) returning 403 are rare; map to a generic `GitLabForbiddenError` without invalidating credentials in the client.

Client **does not** mutate membership cache or credentials — it only throws. Callers apply D4.

---

## 10. Commit vs MR cursor compatibility (D5 — locked)

| Resource | GitLab filter | ReviewPulse cursor (later WP6) | WP2 client param |
|---|---|---|---|
| Commits | `since` + `until` (+ optional `ref_name`) | `CommitSyncState.watermark_authored_at` + lookback overlap | `ListCommitsQuery.since` / `.until` |
| Merge requests | `updated_after` | `MrSyncState.updated_after_cursor` | `ListMergeRequestsQuery.updatedAfter` |

**Forbidden assumptions:**
- Do not pass `updated_after` to commits API.
- Do not pass `since`/`until` as a substitute for MR `updated_after`.
- Do not share one cursor type between commit and MR helpers.
- Lookback overlap math (`COMMIT_LOOKBACK_OVERLAP_SECONDS`) lives in sync orchestration (WP6), not inside the HTTP client — WP2 only transports the dates it is given.

---

## 11. Read-only guarantee

1. `GitLabReadClient` interface exposes GET-only operations listed in §1.
2. Internal `request()` helper accepts method union `"GET"` only (TypeScript).
3. Tests: assert package sources under `packages/gitlab-client/src/**` contain no string literals issuing `POST`/`PUT`/`PATCH`/`DELETE` to GitLab (allowlist test file comments carefully).
4. Optional ESLint `no-restricted-syntax` / custom test scanning `method:` / `.request(` call sites.
5. CI job already runs package tests — add `gitlab-client` mutation-ban test to that suite.

---

## 12. Test matrix (mandatory)

Use mock HTTP (`MockAgent` / undici MockAgent, or injectable `FetchLike`) — **no live GitLab required** for WP2 unit/integration.

| Case | Expect |
|---|---|
| Pagination via `Link: rel=next` | Second page fetched with cursor; ends when no next |
| Pagination via `X-Next-Page` | Same |
| 401 on `/user` | `GitLabUnauthorizedError`; no credential side effects in client |
| 403 on project A then 200 on project B | Forbidden for A; B succeeds with same token |
| 404 on project | `GitLabProjectNotFoundError` |
| 429 with `Retry-After: 1` | Waits ≥1s (fake timers); eventually success or rate-limit error |
| 503 then 200 | Retries then success |
| Timeout | `GitLabTimeoutError`; no hang |
| Caller abort | `GitLabAbortedError` |
| 302 redirect | `GitLabRedirectRejectedError`; **zero** follow-up request to Location |
| SSRF: allowlisted host → public IP | Allow |
| SSRF: allowlisted host → RFC1918 (if A1 approved) | Allow |
| SSRF: allowlisted host → `169.254.169.254` | Block |
| SSRF: non-allowlisted host | Block |
| SSRF: DNS returns mixed denied+allowed | Block (fail closed) |
| Oversized body | `GitLabResponseTooLargeError` |
| Malformed JSON / missing SHA | `GitLabMalformedResponseError` |
| Token in logs/errors | Redacted; assert serialized errors/logs omit PAT and `PRIVATE-TOKEN` value |
| Mutation ban | Source scan / type-level GET-only |
| Commits query wiring | Mock asserts `since`/`until` present; `updated_after` absent |
| MR query wiring | Mock asserts `updated_after` present |

---

## 13. Files expected at implement time

| Path | Role |
|---|---|
| `packages/gitlab-client/src/client.ts` | `GitLabReadClient` implementation |
| `packages/gitlab-client/src/types.ts` | Public DTOs |
| `packages/gitlab-client/src/mappers.ts` | GitLab JSON → DTO with required-field validation |
| `packages/gitlab-client/src/errors.ts` | Typed error taxonomy (context deep-redacted) |
| `packages/gitlab-client/src/url.ts` | Normalization, exact allowlist, safe path join |
| `packages/gitlab-client/src/ip.ts` | Strict IPv4/IPv6 parsing + address classification |
| `packages/gitlab-client/src/ssrf.ts` | Allowlist + DNS validation + pin decision |
| `packages/gitlab-client/src/transport.ts` | GET-only `node:https` transport with pinned lookup |
| `packages/gitlab-client/src/http.ts` | Retry budget, timeouts, size cap, status mapping |
| `packages/gitlab-client/src/limits.ts` | A7/A8/pagination defaults |
| `packages/gitlab-client/src/auth.ts` | `GitLabAuthAdapter` + PAT adapter |
| `packages/gitlab-client/src/pagination.ts` | Link / X-Next-Page parsing, `drainPages` |
| `packages/gitlab-client/src/test-support.ts` | Mock transport / resolver (not exported from index) |
| `packages/gitlab-client/src/readonly.test.ts` | Mutation-ban |
| `packages/gitlab-client/src/*.test.ts` | Matrix above |
| `packages/gitlab-client/src/index.ts` | Public exports (replaces the WP0 stub) |
| `packages/gitlab-client/package.json` | Dep: `@reviewpulse/crypto` for redaction; **not** `@reviewpulse/db` |
| `.env.example` | Allowlist format incl. the `internal:` prefix (placeholders only) |
| `docs/PLAN-M1-Implementation.md` | WP2 status → APPROVED, then PASS when verified |

**Explicitly not changed in WP2:** Prisma schema, credentials crypto, AppAuth, web routes/UI, worker sync.

---

## 14. Acceptance criteria

1. `GitLabReadClient` implements all methods in §1 against mock GitLab with correct endpoints/query params.
2. PAT only via `PRIVATE-TOKEN` header; never in URL; never in logs/errors (tested).
3. SSRF policy matches approved A1/A2; metadata/link-local/loopback always denied; redirects not followed (if A2=0).
4. Pagination works from Link and X-Next-Page.
5. Retry honors 429/`Retry-After` and 5xx within A8 budget; 401/403/404 not retried.
6. Timeout, abort, and 8 MiB (or approved) size cap enforced.
7. Error taxonomy distinguishes unauthorized vs project forbidden/not found vs rate limit vs timeout vs upstream vs malformed vs SSRF.
8. Commits use `since`/`until`; MRs use `updated_after`; no shared cursor type.
9. Read-only guarantee enforced by types + tests.
10. Full test matrix green; lint / typecheck / test / build / `npm audit --omit=dev` green.
11. No AppAuth/UI/sync/OAuth/mutation code introduced.

---

## 15. Effort & blockers

| Item | Estimate |
|---|---|
| SSRF + URL normalize + IP classify + tests | 1.0–1.5 d |
| HTTP transport (retry/timeout/size) + pagination | 1.0 d |
| Resource methods + DTO mapping + 401/403/404 tests | 1.0 d |
| Read-only ban + redaction assertions + docs | 0.5 d |
| **Total** | **~3.5–4.0 d** |

**Blockers / dependencies:** none remaining.
- **A1–A8 approved** (fast-track, 2026-08-05).
- WP1 PASS (done) for the PAT provider used by later callers — WP2 itself requires no Postgres because the auth adapter is injected.
- **Transport decision (locked):** Node built-in `node:https`/`node:http` with a pinned `lookup` and explicit `servername`. `fetch`/undici cannot pin the socket to a pre-validated IP while preserving TLS SNI without a custom dispatcher, so the thin built-in wrapper is used. **No new runtime dependency.** Tests inject a `GitLabHttpTransport` mock instead of hitting the network.

**Non-blockers deferred:**
- WP1 review note (invalidate by connection after rotate) — document for WP3b/WP6 callers; do not auto-invalidate inside WP2 client.
- TB-WP0 backlog items.

---

## 16. Implement prompt (copy when APPROVED)

```text
Implement WP2 only per docs/PLAN-M1-WP2-Execution.md (must be APPROVED/LOCKED) and
docs/PLAN-M1-Implementation.md. WP0=PASS, WP1=PASS.

Branch: feat/m1-wp2-gitlab-read-client from latest main.

IN:
- GitLabReadClient GET-only API (§1) with endpoints (§2)
- PRIVATE-TOKEN header only; TokenProvider injectable; no Prisma in gitlab-client
- URL normalization + exact allowlist; SSRF policy per approved A1/A2
- Pagination Link/X-Next-Page; retry A8; timeout/abort/size A7
- Error taxonomy §9; commits since/until; MRs updated_after
- Mock HTTP test matrix §12; mutation-ban test
- Redact secrets in logs/errors via @reviewpulse/crypto

OUT:
- AppAuth/session/UI/Settings, sync worker, membership cache, dashboard
- OAuth/SSO/Redis/webhook/AI/NVIDIA
- Any GitLab mutation method
- Do not clear TB-WP0-* unless separately approved
- Any scope change: stop and ask

Acceptance: §14. Stop — do not start WP3.
```

---

## Decision summary (APPROVED 2026-08-05)

| Topic | Locked |
|---|---|
| Public API | §1 `GitLabReadClient` + `GitLabAuthAdapter` + `GitLabInstanceContext` |
| Auth | `PRIVATE-TOKEN` header only; never URL |
| Allowlist | Exact canonical-origin match |
| Private IP | RFC1918/ULA only for exact-allowlisted `internal` origins; loopback/link-local/metadata always denied; all DNS answers validated; socket pinned to validated IP; hostname kept for TLS (**A1**) |
| Redirects | Follow 0; TLS verification never disabled (**A2**) |
| Pagination | Link + X-Next-Page; same-origin only; `perPage` 100 / `maxPages` 100 / `maxItems` 10 000; cycle detection |
| Retry | 429/408/502/503/504 + network; 4 attempts incl. first; 15 s/attempt; 45 s total; expo+jitter cap 8 s; `Retry-After` only within remaining budget; abort stops immediately (**A8**) |
| Limits | 8 MiB per page body (**A7**) |
| Errors | Typed taxonomy; 401 ≠ project 403/404 |
| Cursors | Commits `since`/`until`; MRs `updated_after`; separate types |
| Read-only | GET-only types + mutation-ban tests |
| Transport | Node built-in `https`/`http` with pinned lookup; no new dependency |
| Effort | ~3.5–4 d |
