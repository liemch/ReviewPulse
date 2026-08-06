# WP3 + WP4 Execution Plan — AppAuth, GitLab Settings, Allowlist & Enable

Status: **IMPLEMENTED — all gates green on local PostgreSQL** — 2026-08-05  
Evidence: 3 migrations applied (`db:migrate:status` up to date, 19 public tables); lint/typecheck/build clean; `npm audit` (with and without dev) 0 vulnerabilities; **324 tests pass / 0 fail / 0 skipped** including PostgreSQL integration suites for AppAuth, GitLab settings, allowlist/enable, credential vault, and connection invariants.  
Awaiting review/merge before marking **PASS**. Not starting WP5.  
Parent: `docs/PLAN-M1-Implementation.md` (APPROVED) · `docs/SPEC-ReviewPulse-M1-M4.md`  
Prerequisites: **WP0 = PASS**, **WP1 = PASS**, **WP2 = PASS**  
Branch: `feat/m1-wp3-wp4-auth-projects`

WP3 (AppAuth + sessions + CSRF + GitLab connection Settings) and WP4 (instance/project allowlist + per-user enable) ship together. Membership cache (WP5), sync (WP6), dashboard (WP7), and hardening (WP8) stay out.

---

## 0. Locked decisions

| ID | Topic | Locked |
|---|---|---|
| **S1** | No public signup | Admin create/invite only; no `/signup` |
| **S2** | Password | Argon2id via `@node-rs/argon2`; never plaintext/reversible |
| **S3** | Email | NFKC + trim + lower; unique on `normalized_email` |
| **S4** | Roles | `admin` \| `tech_lead` \| `developer` |
| **S5** | Sessions | Opaque cookie token; DB stores **hash only** (HMAC-SHA256 with `SESSION_SECRET`) |
| **S6** | TTL | Absolute **12h** (`SESSION_ABS_TTL_SECONDS=43200`); idle **2h** (`SESSION_IDLE_TTL_SECONDS=7200`) per SPEC FR-APP3 / parent D8. FAST-TRACK mentioned 30m idle — **parent plan wins**. |
| **S7** | Rotation | New session on login; prior session revoked (`rotated_from` link) |
| **S8** | Cookie | `httpOnly`; `SameSite=Lax`; `Secure` when HTTPS; `__Host-rp_session` when HTTPS deploy, else `rp_session` for local HTTP |
| **S9** | CSRF | Double-submit cookie `rp_csrf` + matching form/header field **and** Origin/Referer allowlist check on state-changing routes |
| **S10** | Lockout | **5 failures** → lock 15 min on the user row; separately **20 failures / min per IP-hash** (in-memory + DB counters) |
| **S11** | Bootstrap | CLI `npm run auth:bootstrap-admin` — password from env/`--password-file` only; no HTTP bootstrap; no committed password |
| **S12** | GitLab PAT | `PRIVATE-TOKEN` via WP2 client; M1 scope `read_api` only; never shown again in UI |
| **S13** | Identity | `(gitlab_instance_id, gitlab_user_id)` unique among live connections (existing partial unique index) |
| **S14** | WP4 authz | Live: allowlist ∩ GitLab-visible (via WP2 `listAccessibleProjects` / `getProject`) ∩ per-user enable. **No membership cache.** Fail closed on GitLab errors / uncertainty. |
| **S15** | Admin GitLab | Admin role does **not** imply GitLab project read; admin uses their own PAT connection like any user |
| **S16** | Migrations | Additive only; never rewrite WP0/WP1 baselines |
| **S17** | GitLab test seams | `GitLabIdentityProbe` + `VisibleProjectsLoader` are injectable; defaults stay the WP2 client under the SSRF guard (see §6) |

**Out of scope:** WP5–WP8, OAuth/SSO, Redis, webhook, AI/NVIDIA, GitLab mutations, KPI verdicts, email self-serve reset.

---

## 1. Schema deltas (additive)

Existing skeleton already has `User`, `Session`, `GitLabInstanceAllowlist`, `GitLabConnection`, `UserCredential`, `ReviewPulseProjectAllowlist`, `UserProjectEnable`, `AuditEvent`, `MembershipCache`.

**New migration `20260805180000_wp3_wp4_auth_settings`:**

| Change | Why |
|---|---|
| `users.failed_login_count INT NOT NULL DEFAULT 0` | Lockout counter |
| `users.locked_until TIMESTAMPTZ NULL` | Temporary lockout |
| `gitlab_instance_allowlist.label TEXT NULL` | Admin-facing name |
| `gitlab_instance_allowlist.internal BOOLEAN NOT NULL DEFAULT false` | WP2 SSRF `internal` opt-in for RFC1918 |

CSRF uses double-submit cookie + Origin/Referer (no extra `sessions.csrf_secret` column).  
No plaintext password/session/PAT columns. Partial unique indexes from WP0/WP1 remain.

---

## 2. Package design

### `@reviewpulse/app-auth`
- `normalizeEmail`
- `hashPassword` / `verifyPassword` (Argon2id)
- `LocalPasswordAuthProvider` (`AppAuthProvider`)
- `SessionService`: create / rotateOnLogin / validate / touch / revoke / revokeAll
- `CsrfService`: issue / verify
- `UserAdminService`: create/invite, deactivate, resetPassword, list
- `AuditWriter`: safe meta only
- Typed safe errors (`safeForClient`)

### `@reviewpulse/domain`
- `ProjectAccessService` implementation: intersection listing + enable/disable with ACL
- `AllowlistAdminService`: instance + project allowlist CRUD (admin only)

### `apps/web`
- Route handlers + minimal HTML forms (usable, not polished)
- Server wiring: Prisma + sealer + GitLab client + services
- CLI: `scripts/bootstrap-admin.ts`

---

## 3. HTTP surface

| Method | Path | Auth | CSRF | Purpose |
|---|---|---|---|---|
| GET | `/login` | public | — | Login form |
| POST | `/api/auth/login` | public | Origin + CSRF | Login |
| POST | `/api/auth/logout` | session | yes | Logout |
| POST | `/api/auth/sessions/revoke-all` | session | yes | Revoke all |
| GET | `/settings/security` | session | — | Session/security UI |
| GET/POST | `/settings/admin/users` | admin | yes on POST | User management |
| GET/POST | `/settings/gitlab` | session | yes on POST | Connection test/save/replace/delete |
| GET/POST | `/settings/projects` | session | yes on POST | List intersection; enable/disable |
| GET/POST | `/settings/admin/allowlist` | admin | yes on POST | Instance + project allowlist |

No `/signup`. Bootstrap is CLI-only.

---

## 4. GitLab connection flow

1. User submits exact-allowlisted base URL + PAT (never logged).
2. Normalize URL; require allowlist row (and `internal` flag for private IPs).
3. `createGitLabReadClient` + `getCurrentUser`.
4. On success: upsert `GitLabConnection` with GitLab user id/username; `storeCredential` / `replaceCredential`.
5. On identity conflict (partial unique): typed safe error — do not leak other user's email.
6. UI shows username, last4 hint, status, last validated — never PAT.
7. Delete → connection `deleted` + invalidate credential `connection_deleted` + delete `MembershipCache` rows for user+instance (prep for WP5).
8. GitLab 401 on test → do not kill app session; mark credential invalid if already stored.

---

## 5. Allowlist + enable (WP4)

1. Admin adds instance (canonical origin, `internal` flag) and projects (`gitlab_project_id`, optional path).
2. User lists: `ReviewPulseProjectAllowlist` for their connected instance(s) ∩ projects returned by `listAccessibleProjects` (paginated drain with WP2 caps).
3. Enable writes `UserProjectEnable` only if both checks pass in the same request.
4. Disable deletes/disables own row only.
5. IDOR: every mutation scopes by `session.userId`; admin allowlist mutations require `role=admin`.
6. No shared cache as authz. Uncertain GitLab response → fail closed (no enable, empty list with error).

---

## 6. Test matrix (mandatory)

Verified 2026-08-05 on local PostgreSQL (`reviewpulse`/`public`, 3 migrations, 19 tables). Suite totals: **324 pass / 0 fail / 0 skipped**.

| Requirement | Where | Result |
|---|---|---|
| No public signup route | `apps/web/src/wp3-surface.test.ts` | PASS |
| Argon2id hash; plaintext absent from row/JSON | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Session token hashed at rest (no raw token in row) | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Rotate on login + fixation (old cookie dead) | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Idle expiry revokes row; absolute expiry rejected; 12h/2h asserted | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Lockout after 5 failures; counter reset on success | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Deactivated user: sessions revoked + old cookie rejected | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Admin reset revokes sessions; only new password works | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Role escalation refused on admin user ops | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Email normalize + duplicate conflict | `app-auth/auth-flow.integration.test.ts` | PASS (DB) |
| Audit rows free of password/session/PAT | `app-auth/auth-flow.integration.test.ts` + `security.test.ts` | PASS (DB) |
| CSRF missing/mismatch + bad Origin rejected | `app-auth/auth.test.ts` (assertions) + `wp3-surface.test.ts` (every mutating route calls both) | PASS (unit + surface) |
| PAT sealed only; last4 hint is the only exposure | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Non-allowlisted GitLab URL refused | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Two users cannot bind one GitLab identity | `domain/gitlab-settings.integration.test.ts` (partial unique index) | PASS (DB) |
| User A cannot read/delete/retest B's connection (IDOR) | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Replace supersedes credential + clears membership cache | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Delete revokes credential (`connection_deleted`) + clears cache | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Revoked PAT → credential/connection `invalid`, account untouched | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| List = allowlist ∩ GitLab-visible | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Cannot enable outside allowlist or outside visible set | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Enable is per-user; disable touches only caller's row | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| Fail closed when GitLab access unverifiable | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| No connection ⇒ authorizes nothing (admin has no implicit read) | `domain/gitlab-settings.integration.test.ts` | PASS (DB) |
| WP0/WP1 connection + credential invariants still hold | `db/connection-invariants.integration.test.ts`, `credentials/*.integration.test.ts` | PASS (DB) |
| Additive migration; no drops/plaintext columns | `db/migration-invariants.test.ts` | PASS |
| Mutation-ban + SSRF policy unchanged | `gitlab-client` suite (160) + `domain`/`web` write-verb scans | PASS |

**Deliberately not covered here:** browser-level CSRF/cookie round trip and route-handler HTTP wiring (needs a running Next server; the route layer is asserted by source-surface tests instead). Membership-cache TTL behaviour stays WP5.

### Test seams (locked as **S17**)

`GitLabConnectionService` takes an optional `GitLabIdentityProbe` and `LiveProjectAccessService` an optional `VisibleProjectsLoader`. Defaults are the WP2 read client under the SSRF guard (`createGitLabIdentityProbe` / `createVisibleProjectsLoader`), so production wiring is unchanged. Tests inject stubs because WP2 policy denies loopback for every origin — a local GitLab is not a legal target, so a stub is the only way to exercise these paths on PostgreSQL.

---

## 7. Acceptance

Matches parent M1 acceptance items 1–6, 9 (partial — dual authz without membership TTL cache), 15–16 for this scope. Stop before WP5.
