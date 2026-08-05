---
gstack_spec:
  status: archived
  file_only: true
  github_issue: null
  execute: false
  quality_gate: skipped_codex_timeout
  redaction: skipped_bun_missing_manual_clean
  semantic_review: clean
  demand: unverified
  milestones: [M1, M2, M3, M4]
  implement_order: M1>M2>M3>M4
  m3_m4_blocked_until: ai_security_privacy_signoff
---

# Epic: ReviewPulse — Internal GitLab prototype (M1–M4)

**Type:** Epic (executable specification)  
**Status:** ARCHIVED (file-only) — 2026-08-05T05:54:59Z  
**Repo:** ReviewPulse (greenfield; only `CLAUDE.md` present as of 2026-08-05)  
**Demand:** **UNVERIFIED** (office-hours Q1=C). Do not treat interest as validated pull.  
**Personas:** DEV-01, TL-01 (anonymous; no real names in this spec)  
**Source design:** `~/.gstack/projects/ReviewPulse/hoang-liem-master-design-20260805-124012.md`  
**Flags:** dedupe skipped (`gh` unavailable), gate=ON (runs after confirm), audit=OFF, execute=ask-at-Phase-5  

---

## Context

Today, DEV-01 and TL-01 rely on GitLab UI + manual copy into reports to check whether commits/MRs are visible for KPI windows, and to review/merge MRs. There is no internal hub that (1) surfaces commit/MR activity with email-mismatch warnings without scoring KPI, (2) lets reviewers act on MRs with the user’s own GitLab permissions, or (3) drafts AI findings for human decision. ReviewPulse is an internal prototype to provide that hub. GitLab remains source of truth; AI never auto-comments, auto-approves, or auto-merges; merges always require explicit user confirmation and live GitLab rule checks.

**Sequencing (mandatory):** Implement **M1 → M2 → M3 → M4**. Each milestone must meet its acceptance criteria and tests before the next starts. Full architecture is specified up front; that does **not** authorize implementing everything at once. **M2** requires authorization + merge-safety review before any mutation code ships. **M3–M4** require security/privacy sign-off for sending diffs to AI; without that sign-off they remain in-spec but **BLOCKED** (no implementation).

---

## Current State

| Area | Verified state (2026-08-05) |
|------|------------------------------|
| Codebase | Greenfield: git repo + `CLAUDE.md` skill routing only. No app, no CI, no remote. |
| Product usage | None. Demand unverified. |
| Workflow (hypothesized) | GitLab browse → filter by author/time → copy to sheet/report → review MR in GitLab → chat/meeting for blockers. |

---

## Goals (product)

1. Reduce daily GitLab polling by DEV-01 to verify commit/MR visibility for KPI windows.  
2. Give TL-01 a concentrated MR workspace (list → inspect → comment/approve/merge under GitLab rules).  
3. Offer AI draft review of diffs before a human decides merge — never autonomous merge/approve/comment.

**Non-goals (product):** Automatic KPI scoring or KPI pass/fail conclusions from commit/MR counts.

---

## Personas & journeys

### DEV-01 — Developer (KPI visibility)

**Job:** Confirm my commits/MRs in selected projects are visible for the reporting window; notice email mismatches early.  
**Journey (M1+):** Connect/select projects → open Personal Dashboard → filter by my configured email + date range → see commits, MRs created/merged/open → follow GitLab deep links → fix email if mismatch warned → export/share table (optional later).  
**Does not:** Receive automated KPI grade; merge other people’s MRs unless also a reviewer with rights.

### TL-01 — Tech lead / reviewer

**Job:** See team MR queue; review diffs; comment/approve/merge safely; optionally run AI draft review.  
**Journey:**  
- M1: Team/project dashboard filters (authors, ranges).  
- M2: MR workspace → open MR → metadata/pipeline/approvals/conflicts/diff → comment / approve / merge with confirmation + safety gate.  
- M3: Request AI review → browse draft findings → accept / dismiss / false-positive.  
- M4: Select findings → post to GitLab as comments → see quality metrics (FP rate, latency, cost).

---

## Scope boundaries

### In scope (architecture target)

- GitLab instance connection via token; project/group selection within caller’s access.  
- Sync commits + MRs (pagination, rate limit, retry, incremental).  
- Commit/MR dashboard (email + time filters, deep links, email mismatch warnings; **no KPI scoring**).  
- MR workspace: list/filter; metadata; pipeline; approvals; conflicts; diff; comment; approve; merge with confirmation.  
- All mutations use **the acting user’s GitLab credentials/permissions**.  
- Audit log for comment/approve/merge.  
- Head-SHA change handling during review.  
- AI review pipeline (draft → human feedback → optional post in M4) with provider abstraction.  
- Merge safety gate re-checked against live GitLab.  
- Security: token encryption, webhook secret verify, SSRF guard on GitLab URL, authz on every project/MR, no secrets/diffs in app logs, audit + retention, threat model.

### Explicitly out of scope

- Auto-merge, AI auto-approve, AI auto-comment without user confirmation.  
- Replacing GitLab as SoT or bypassing protected branches / approval / pipeline rules.  
- Automatic KPI scoring, ranking, or performance conclusions.  
- Multi-tenant SaaS / public cloud product packaging.  
- Non-GitLab SCMs (GitHub, Bitbucket).  
- Full IDE replacement; running user tests inside ReviewPulse.  
- Shadow/interview research execution (process outside this epic; demand remains unverified).  
- Implementing M3–M4 before security/privacy sign-off.

---

## Proposed defaults (human-approved later — see Decisions)

| Topic | Proposed default | Rationale |
|-------|------------------|-----------|
| Stack | TypeScript monorepo: Next.js (App Router) UI + NestJS or Next route handlers API; PostgreSQL; Redis/BullMQ workers | Fast internal prototype; strong typing; good GitLab API ecosystem |
| AuthN | App session (OIDC/SSO or local) + **per-user GitLab OAuth** for API mutations; optional instance PAT encrypted for read-sync bootstrap | Matches “user’s GitLab permissions” |
| GitLab | Self-managed **or** gitlab.com via configurable base URL (SSRF allowlist) | Internal companies often self-host |
| AI | Provider interface: `CloudLLMProvider` + `InternalHTTPProvider`; default off per project | M3 blocked until sign-off |
| Hosting | Internal VPC / company K8s or VM behind SSO | Prototype |

---

## Architecture & trust boundaries

```
[Browser / DEV-01|TL-01]
        | HTTPS + session
        v
[ReviewPulse Web/API] ----encrypts----> [Secrets vault / KMS-backed DB column]
        | user OAuth token (in-memory / short-lived cache; refresh encrypted at rest)
        | server-side only
        v
[GitLab API + Webhooks]  <==== SoT ====
        |
        | (M3+) redacted diff chunks only
        v
[AI Provider]  (cloud or internal)  -- never receives GitLab tokens / full repo / secrets
```

**Trust boundaries**

1. Browser ↔ App: session authz; CSRF on mutations.  
2. App ↔ GitLab: TLS; OAuth/PAT; webhook HMAC.  
3. App ↔ AI: TLS; minimal diff payload; no tokens; project kill-switch.  
4. App ↔ DB: encrypted tokens; audit rows; retention job.  
5. Logs: structured; deny-list for token/Authorization/diff/body secrets.

---

## Functional requirements

### FR-G — GitLab integration (M1+)

| ID | Requirement |
|----|-------------|
| FR-G1 | Connect one GitLab base URL + credentials; reject SSRF-prone URLs (metadata IPs, link-local, non-allowlisted hosts). |
| FR-G2 | List groups/projects the credential can access; user selects sync set. |
| FR-G3 | Sync commits and MRs with pagination, 429/5xx retry+backoff, and incremental cursors (`updated_after` / webhook catch-up). |
| FR-G4 | On conflict with local cache, GitLab API wins; mark local row `stale` until refresh. |
| FR-G5 | Verify webhook secrets; ignore unsigned/invalid. |

### FR-D — Dashboard (M1)

| ID | Requirement |
|----|-------------|
| FR-D1 | Filter by author email + time range. |
| FR-D2 | Show commits, MRs created, MRs merged, MRs open/waiting. |
| FR-D3 | Each row links to GitLab web URL. |
| FR-D4 | Warn when commit author email ≠ user-configured emails (alias list). |
| FR-D5 | **Must not** compute KPI scores, grades, or pass/fail labels. |

### FR-M — MR workspace (M2)

| ID | Requirement |
|----|-------------|
| FR-M1 | List MRs by state, project, author, reviewer. |
| FR-M2 | Show metadata, pipeline status, approvals, conflicts, diff (via GitLab API). |
| FR-M3 | Comment, approve, accept/merge **using acting user’s GitLab token**. |
| FR-M4 | Confirmation modal before approve or merge (explicit action text). |
| FR-M5 | Never bypass protected branch, approval rules, or pipeline rules. |
| FR-M6 | Audit log: actor, action, project, MR iid, before/after SHA, result, timestamp. |
| FR-M7 | If head SHA changes mid-review, UI marks session stale; block merge until refresh/reconfirm. |

### FR-A — AI review (M3–M4)

| ID | Requirement |
|----|-------------|
| FR-A1 | Send only diff hunks + minimal context (path, language, MR title/desc truncated); never tokens, `.env`/secret-like files, or full repo. |
| FR-A2 | Chunk large MRs by file; aggregate findings. |
| FR-A3 | Finding schema: severity, category, file, line range, evidence, explanation, suggestion, confidence. |
| FR-A4 | Validate line positions against **current head SHA** before display or post. |
| FR-A5 | Deduplicate findings across runs (hash of file+range+category+fingerprint). |
| FR-A6 | User: accept / dismiss / false_positive. |
| FR-A7 | No GitLab comment until user confirms (M4). |
| FR-A8 | AI cannot approve or merge. |
| FR-A9 | If provider down: fail safe — empty findings + error state; MR flows still work. |
| FR-A10 | Persist model, prompt_version, commit SHA, timestamps, raw normalized result. |
| FR-A11 | Per-project AI disable flag. |
| FR-A12 | Provider abstraction for cloud vs internal model. |
| FR-A13 | If head SHA changes after review: mark review `stale`; invalid for merge policy if policy enabled (M4). |

### FR-S — Merge safety gate (M2+)

Merge allowed only if GitLab confirms **all**:

1. User has merge permission on target.  
2. MR head SHA == SHA user reviewed/confirmed.  
3. No merge conflicts.  
4. Pipeline satisfies project rules.  
5. Approval rules satisfied.  
6. MR not draft.  
7. User manually confirmed in UI.

If AI review policy enabled (M4) and head SHA changed: require fresh AI review before merge.

---

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | Sync worker handles GitLab rate limits without dropping cursors (at-least-once; idempotent upserts). |
| NFR-2 | P95 dashboard query < 2s for ≤50k commits cached per pilot team (target; measure in M1). |
| NFR-3 | Tokens encrypted at rest (AES-GCM or KMS); never plaintext in DB/logs. |
| NFR-4 | Authz check on every project/MR API: membership via GitLab or mirrored ACL refreshed ≤15m. |
| NFR-5 | Audit retention configurable (default 180d); diffs not stored in audit beyond SHA/refs. |
| NFR-6 | AI latency budget logged; hard timeout (e.g. 120s) → fail safe. |
| NFR-7 | Threat model doc reviewed before M2 mutations and before M3 AI. |

---

## GitLab API surface (minimum)

| Use | Method / path (GitLab REST v4 unless noted) |
|-----|-----------------------------------------------|
| Auth identity | `GET /user` |
| Groups/projects | `GET /groups`, `GET /groups/:id/projects`, `GET /projects` |
| Commits | `GET /projects/:id/repository/commits` |
| MRs list | `GET /projects/:id/merge_requests` |
| MR detail | `GET /projects/:id/merge_requests/:iid` |
| MR diffs | `GET /projects/:id/merge_requests/:iid/diffs` (+ versions/changes as needed) |
| Discussions | `GET/POST .../merge_requests/:iid/discussions` |
| Notes | `POST .../merge_requests/:iid/notes` |
| Approve | `POST .../merge_requests/:iid/approve` |
| Merge | `PUT .../merge_requests/:iid/merge` |
| Approvals | `GET .../merge_requests/:iid/approvals` |
| Pipelines | `GET .../merge_requests/:iid/pipelines` |
| Conflicts | from MR detail `has_conflicts` + merge status fields |
| Webhooks admin | project/group hook CRUD (ops) |

GraphQL may supplement for efficiency; REST is the baseline contract.

### Webhook events (M1 optional, M2 recommended)

- `push`  
- `merge_request` (open/update/merge/close/reopen)  
- `pipeline`  
- `note` / `merge_request` discussion (optional for cache invalidation)  

Handler: verify secret → enqueue incremental sync → idempotent by `event_uuid`/`object_kind`+id+updated_at.

---

## Data model (logical)

```
User(id, email, gitlab_user_id, configured_emails[], created_at)
GitLabConnection(id, base_url_hash, encrypted_credentials, created_by, status)
SyncedProject(id, connection_id, gitlab_project_id, path_with_namespace, sync_cursor, ai_enabled)
CommitCache(project_id, sha, author_email, authored_at, title, web_url, raw_updated_at)
MergeRequestCache(project_id, iid, title, state, author_email, reviewer_ids[], head_sha,
                  target_branch, is_draft, has_conflicts, pipeline_status, web_url, updated_at)
OAuthToken(user_id, encrypted_access, encrypted_refresh, expires_at, scopes)
AuditEvent(id, actor_user_id, action, project_id, mr_iid, before_sha, after_sha, payload_meta, ts)
AiReviewRun(id, project_id, mr_iid, head_sha, model, prompt_version, status, started_at, finished_at, error)
AiFinding(id, run_id, fingerprint, severity, category, file, line_start, line_end,
          evidence, explanation, suggestion, confidence, user_state) 
  -- user_state: open|accepted|dismissed|false_positive
AiFindingPost(id, finding_id, gitlab_note_id, posted_by, posted_at)
AiQualityMetric(run_id, latency_ms, token_in, token_out, cost_estimate, fp_count, finding_count)
```

### State machines

**MR review session (UI):** `open → reviewing → stale(head_changed) → refreshed → action_pending → completed`  

**AiReviewRun:** `queued → running → succeeded|failed → stale(if head_sha≠current)`  

**AiFinding.user_state:** `open → accepted|dismissed|false_positive` (M4 post only from `accepted` or explicit selection set)

**Merge attempt:** `precheck → confirm_ui → live_revalidate_gitlab → merge_call → audit` (abort at any fail)

---

## Authorization model

| Action | Rule |
|--------|------|
| View dashboard project | User can `read_api` that project on GitLab (mirrored). |
| View MR/diff | Same + MR visible to user on GitLab. |
| Comment / approve / merge | Must use **user OAuth token**; GitLab enforces permissions; App prechecks then live revalidate. |
| Configure connection | Admin/champion role in App. |
| Enable AI / post findings | Project maintainer-equivalent in App ACL **and** GitLab permission to note on MR. |
| Read audit | Admin or project maintainer role. |

App must not grant powers GitLab denies. Cache ACL is optimization; mutations always hit GitLab.

---

## AI review pipeline & schema

1. Load MR diffs for `head_sha`.  
2. Secret/file filter (deny: `*.pem`, `.env*`, `id_rsa`, known secret paths; redact high-entropy assignments).  
3. Chunk by file / size limit.  
4. Call `AiProvider.review(chunks, meta)` → structured JSON.  
5. Validate schema; map lines to current diff; drop invalid positions.  
6. Fingerprint + dedupe vs prior runs on same project/MR.  
7. Persist `AiReviewRun` + `AiFinding` (`user_state=open`).  
8. UI: accept/dismiss/FP.  
9. M4: user selects → post notes via user token → record `AiFindingPost` + metrics.

### Structured output (provider must return)

```json
{
  "findings": [
    {
      "severity": "low|medium|high|critical",
      "category": "bug|security|test_gap|style|perf|other",
      "file": "path/to/file.ts",
      "line_start": 10,
      "line_end": 18,
      "evidence": "quoted code or description",
      "explanation": "why it matters",
      "suggestion": "how to fix",
      "confidence": 0.0
    }
  ],
  "model_meta": { "notes": "optional" }
}
```

---

## Failure modes & recovery

| Failure | Behavior |
|---------|----------|
| GitLab 429 | Exponential backoff; preserve cursor; surface sync delayed. |
| GitLab 5xx / network | Retry then mark sync error; serve last-good cache with banner. |
| OAuth expired | Force re-auth; block mutations. |
| Webhook bad signature | 401; no side effects. |
| SSRF URL configure | Reject save. |
| Head SHA changed pre-merge | Abort merge; require refresh. |
| AI timeout/error | `AiReviewRun=failed`; empty findings; no block on M2 merge unless M4 policy on. |
| Partial chunk AI failure | Persist partial + warning; no auto-post. |
| Duplicate webhook | Idempotent no-op. |

---

## Threat model (summary — expand before M2/M3)

| Asset | Threat | Control |
|-------|--------|---------|
| GitLab token/OAuth | Theft from DB/logs | Encrypt at rest; never log; short cache; rotate |
| Source code / diffs | Leak to logs or AI | Redaction; minimal payload; project AI off; vendor DPA |
| Webhook | Forged events | HMAC secret verify |
| GitLab URL | SSRF to cloud metadata | Allowlist/deny private ranges |
| Authz confusion | IDOR across projects | Check membership every request |
| Merge abuse | UI tricks | Confirm modal + live GitLab gates |

---

## Milestone plan & acceptance

### Implementation rules

1. Order **M1 → M2 → M3 → M4** only.  
2. No next milestone until AC + required tests green.  
3. M2 code that mutates GitLab: blocked until **authorization & merge-safety review** signed.  
4. M3–M4 implementation: blocked until **security/privacy sign-off** for AI diffs; until then keep design in repo docs but no provider calls in prod/staging with real code.

---

### Milestone 1 — GitLab connection, sync, personal dashboard

**Deliverables:** connection UX; project picker; sync worker; DEV-01 dashboard; email mismatch warning; deep links; encrypted secrets; basic authz read path.

**Acceptance criteria**

1. User can save GitLab base URL + credential; invalid/SSRF URLs rejected with clear error.  
2. User selects ≥1 accessible project; inaccessible projects cannot be added (GitLab 403 surfaced).  
3. Worker syncs commits + MRs with pagination; simulated 429 recovers without losing cursor.  
4. Incremental sync brings updates after `updated_after` / webhook without full rescan (verified by fixture).  
5. Dashboard filters by email + date range; shows commit/MR created/merged/open counts/lists.  
6. Every entity shows working GitLab web link.  
7. Commit whose author email ∉ configured emails shows mismatch warning.  
8. UI and API contain **no** KPI score/grade/conclusion fields.  
9. Tokens not readable plaintext from DB dump test.  
10. Unit/integration/security tests for M1 listed below pass in CI.

**M1 tests**

| Layer | What | Count (min) |
|-------|------|-------------|
| Unit | Email mismatch; cursor upsert; SSRF URL classifier | +8 |
| Integration | Sync pagination + 429 retry against GitLab mock | +5 |
| Security | Token encryption round-trip; no token in logs | +3 |
| E2E | Connect → sync fixture → dashboard filter | +2 |

---

### Milestone 2 — MR workspace, comment/approve, merge safety gate

**Gate:** Authorization + merge-safety design review **APPROVED** before merge.

**Deliverables:** MR list/detail/diff; comment; approve; merge with confirm; live revalidation; audit log; head-SHA stale handling; user OAuth for mutations.

**Acceptance criteria**

1. TL-01 lists MRs by state/project/author/reviewer.  
2. Detail shows metadata, pipeline, approvals, conflicts, diff from GitLab.  
3. Comment/approve/merge calls succeed only with user token; server token cannot be used as substitute for mutations.  
4. Approve/merge require confirmation UI; cancel leaves GitLab unchanged.  
5. Merge blocked when any safety rule fails (permission, SHA mismatch, conflicts, pipeline, approvals, draft).  
6. Protected branch / approval / pipeline denials from GitLab are shown; App does not retry-bypass.  
7. Audit events written for comment/approve/merge (success and fail).  
8. If head SHA changes during open session, UI stale + merge blocked until refresh.  
9. IDOR: user A cannot mutate user B’s inaccessible MR (403).  
10. M2 tests pass.

**M2 tests**

| Layer | What | Count (min) |
|-------|------|-------------|
| Unit | Safety gate predicate matrix | +10 |
| Integration | Comment/approve/merge against mock GitLab | +6 |
| Security | IDOR suite; audit completeness | +5 |
| E2E | Review MR → confirm merge happy path + 1 deny path | +3 |

---

### Milestone 3 — AI draft findings + feedback (**BLOCKED** without security sign-off)

**Gate:** Security/privacy sign-off for sending diffs to AI. If missing → milestone stays documented, implementation forbidden.

**Deliverables:** provider abstraction; chunking; draft findings UI; accept/dismiss/FP; fail-safe; per-project AI off; persistence of model/prompt/SHA; **no** GitLab comment posting.

**Acceptance criteria**

1. With AI enabled + sign-off, review run produces schema-valid findings bound to head SHA.  
2. Secret-like files excluded from provider payload (assert in test).  
3. Large MR chunked; findings aggregated once.  
4. Invalid line positions dropped.  
5. Dedupe collapses identical fingerprints across runs.  
6. User can accept/dismiss/false_positive; states persist.  
7. No GitLab note/discussion created in M3.  
8. Provider hard-down → failed run, MR workspace still usable.  
9. Project `ai_enabled=false` → API refuses review start.  
10. M3 tests pass.

**M3 tests**

| Layer | What | Count (min) |
|-------|------|-------------|
| Unit | Redaction; fingerprint; schema validate | +8 |
| Integration | Mock provider success/fail/timeout | +5 |
| Security | Payload scrubber; AI-off enforcement | +4 |
| E2E | Run review → dismiss one finding | +2 |

---

### Milestone 4 — Selective GitLab publish + quality metrics + stale policy

**Gate:** M3 complete + same AI sign-off still valid.

**Deliverables:** multi-select post findings as GitLab notes; metrics (FP rate, latency, cost); policy “require fresh AI review if head SHA changed”.

**Acceptance criteria**

1. User selects N accepted findings → posts N notes with user token; each linked in `AiFindingPost`.  
2. Unselected findings are not posted.  
3. Line check against current head SHA before post; stale lines blocked with message.  
4. Dashboard/admin can see FP rate, latency, cost estimates per project/period.  
5. If policy on and head SHA ≠ review SHA, merge safety gate fails until new successful review.  
6. AI still cannot approve/merge.  
7. M4 tests pass.

**M4 tests**

| Layer | What | Count (min) |
|-------|------|-------------|
| Unit | Publish selection; stale policy flag | +5 |
| Integration | Note create mock; metrics aggregate | +4 |
| Security | No post when AI disabled / no permission | +3 |
| E2E | Post 1 finding → visible note id stored | +2 |

---

## Child issues (suggested split for backlog)

| # | Title | Milestone | Deps |
|---|-------|-----------|------|
| C1 | Bootstrap app skeleton, CI, Postgres, secrets helper | M1 | — |
| C2 | GitLab connection + SSRF guards + encrypted credentials | M1 | C1 |
| C3 | Sync worker commits/MRs + webhooks optional | M1 | C2 |
| C4 | Personal/team dashboard + email mismatch | M1 | C3 |
| C5 | Authz mirror + user GitLab OAuth | M2 | C4 |
| C6 | MR workspace read path (list/detail/diff) | M2 | C5 |
| C7 | Comment/approve + audit log | M2 | C6 + safety review |
| C8 | Merge safety gate + confirm UX | M2 | C7 |
| C9 | AI provider abstraction + redaction/chunking | M3 | C8 + AI sign-off |
| C10 | Findings UI + feedback states | M3 | C9 |
| C11 | Selective GitLab publish | M4 | C10 |
| C12 | Quality metrics + stale-review merge policy | M4 | C11 |

```
C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9 → C10 → C11 → C12
                 (M1 done)              (M2)   (M3 BLOCKED?)   (M4)
```

---

## Rollback plan

| Milestone | Rollback |
|-----------|----------|
| M1 | Disable sync workers; revoke tokens; drop/ignore cache tables; UI feature flag off. |
| M2 | Feature-flag mutations off; users fall back to GitLab UI; audit retained. |
| M3–M4 | `ai_enabled=false` global; no provider calls; optional delete `AiReviewRun` per retention. |

---

## Effort estimate (order-of-magnitude, 1 eng + AI assist)

| Milestone | Breakdown | Total |
|-----------|-----------|-------|
| M1 | 1d bootstrap + 2d GitLab sync + 1.5d dashboard + 1.5d tests/security | ~6d |
| M2 | 1d OAuth/authz + 2d MR UI + 2d mutations/gate + 2d tests/review | ~7d |
| M3 | 2d provider/redaction + 1.5d UI feedback + 1.5d tests (after sign-off) | ~5d |
| M4 | 1.5d publish + 1d metrics/policy + 1d tests | ~3.5d |

Unknowns: GitLab version quirks, SSO integration, AI vendor procurement — may add time.

---

## Files reference (greenfield targets)

| Path (proposed) | Role |
|-----------------|------|
| `apps/web/*` | UI dashboard + MR workspace |
| `apps/api/*` or `apps/web/app/api/*` | HTTP API |
| `packages/gitlab-client/*` | GitLab REST client, retry, pagination |
| `packages/ai-provider/*` | Provider interface + cloud/internal adapters |
| `packages/safety-gate/*` | Merge predicate pure functions |
| `workers/sync/*` | Incremental sync + webhooks |
| `docs/threat-model.md` | Expanded threat model |
| `docs/security-signoff-ai.md` | Checklist for M3 unblock |
| `CLAUDE.md` | Existing routing — keep |

---

## Decisions requiring human approval

1. **Stack finalization** (default TS/Next/Postgres/Redis above).  
2. **Auth:** company SSO provider + GitLab OAuth app registration.  
3. **GitLab base URL allowlist** / self-managed vs gitlab.com.  
4. **M2 authorization & merge-safety review** sign-off owner.  
5. **M3 AI vendor** (cloud vs internal), DPA, data residency, retention.  
6. **Security/privacy sign-off** before any real diff leaves the trust boundary.  
7. **Audit retention** period and who can read audits.  
8. **Whether M4 stale-AI policy is default on** for pilot projects.  
9. **Pilot project/group** selection (not personal identities — team/path only).  
10. **Remote git hosting** for this repo (currently local-only; `gh` unavailable).

---

## Related

- Office-hours design (DRAFT): KPI Pulse wedge vs this full prototype — this epic documents the **full target architecture**; implementation still gated and sequenced; demand **UNVERIFIED**.  
- Out of band: shadow/interview Assignment from office-hours remains recommended before betting the company on adoption; not a blocker for writing this spec.

---

## Definition of Done (epic)

1. M1 AC + tests green in CI.  
2. M2 review sign-off recorded; M2 AC + tests green.  
3. AI security sign-off recorded **or** M3–M4 explicitly deferred with BLOCKED label.  
4. If unblocked: M3 then M4 AC + tests green.  
5. Threat model + runbooks published internally.  
6. No KPI auto-scoring anywhere in UI/API.  
7. AI never auto-comment/approve/merge in any milestone.

---



## Confirmed by requester (2026-08-05)

- Epic covers M1–M4; implement strictly M1→M2→M3→M4.
- M1 is the first implementation milestone.
- M2 requires authorization + merge-safety review before mutation work.
- M3–M4 remain **BLOCKED** until AI security/privacy sign-off.
- GitLab **OAuth per-user** for comment/approve/merge; **no** high-privilege shared service account for mutations.
- GitLab is source of truth.
- No automatic KPI scoring/conclusions.
- AI never auto-comment, auto-approve, or auto-merge.
- Stack default accepted: TypeScript / Next.js + PostgreSQL + Redis.
- AI provider abstraction + per-project AI kill-switch accepted.
- Archive/--file-only only (no GitHub remote/issue).
- No code implementation as part of /spec completion.

## Open implementation notes (non-blocking for draft confirm)

- Exact Nest vs Next-route-handlers: decide at C1.  
- Webhooks in M1 optional; polling acceptable for pilot if network policy blocks hooks.  
- GraphQL batching optional optimization after REST correctness.
