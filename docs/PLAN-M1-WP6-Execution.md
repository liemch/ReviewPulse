# M1 WP6 — PostgreSQL Job Runtime

WP6 adds the durable `project_sync` queue, coalescing scheduler, worker process,
and incremental GitLab commit/MR synchronization on top of the existing M1
tables. It does not change the schema, HTTP API, PAT model, or security boundary.

## Runtime contract

- Only `project_sync` jobs are claimed by this queue.
- Claims are a single PostgreSQL statement using `FOR UPDATE SKIP LOCKED`.
- Claiming changes `pending → running`, records worker/time, and increments
  `attempts`.
- Completion changes `running → completed`.
- Failure with `retryAt` changes `running → pending` while `attempts < 5`;
  otherwise it changes `running → failed`.
- A budget pause changes `running → pending` and undoes that claim's attempt
  increment, because branch continuation is not a failed attempt.
- Credential/access policy failures may change `running → sync_blocked`.
- Stored errors are bounded generic categories. Raw exceptions, response
  bodies, URLs, credentials, and stack traces are never persisted.
- Running claims older than `SYNC_STALE_CLAIM_SECONDS` return to `pending`
  unless their fifth attempt has already been claimed, in which case they
  become `failed`.

State transitions are conditional on the row still being `running`, making a
late worker completion harmless after stale recovery.

## Scheduler and coalescing

The scheduler reads distinct `(gitlab_instance_id, gitlab_project_id)` targets
from `user_project_enables`; multiple users enabling one project produce one
project sync.

For each target, queue insertion takes a transaction-scoped PostgreSQL advisory
lock derived from the job type and both target IDs. Under that lock it checks
for an existing `pending` or `running` job before inserting. This supplies the
required concurrent scheduler guarantee without a new partial unique index or
schema migration. All WP6 enqueue paths use the same lock key.

After any terminal job, the next pending job uses:

`run_after = max(now, latest terminal updated_at + SYNC_POLL_INTERVAL_SECONDS)`

Including `failed` and `sync_blocked` in the cadence prevents a tight job storm
while still allowing a repaired credential or upstream to recover next cycle.

## Incremental synchronization

- Credential coalescing considers only active ReviewPulse users with an enabled
  and still-allowlisted project plus an active connection. Allowlist removal
  clears enables and blocks active jobs. A 401 invalidates that credential and
  user-instance membership rows before trying the next candidate. Project
  403/404 writes only a user-project membership denial. Exhaustion produces
  `sync_blocked`; no shared/admin PAT is used.
- Commits use all returned branches, `since`/`until`, a fixed continuation
  window, an opaque branch-snapshot cursor, the configured overlap, and
  SHA-keyed upserts. Cold-start commit `since` uses `1980-01-01T00:00:00.000Z`
  because live GitLab can return an empty page for Unix-epoch `since` while
  still advancing the watermark. Newly discovered refs are appended to the
  in-progress snapshot so refs sorting before the old cursor are not lost. The
  cursor advances only after a fully drained branch; the watermark advances
  only after the entire branch set succeeds.
- Merge requests use `updated_after`, exact GitLab page cursors, IID-keyed
  upserts, and advance their cursor only after all pages succeed.
- Pagination rejects repeated cursors without imposing a cold-start page cap.
  GitLab access remains GET-only.

## Worker

The signal-aware worker performs runtime preflight, PostgreSQL readiness,
scheduling, stale-claim recovery, atomic claim, sync execution, status/audit
updates, and bounded retry. A running job heartbeats its lease; budget pauses
reschedule without consuming an attempt. Logs and job errors never include PATs,
headers, passwords, sessions, or encryption material.

## Environment

All values are optional positive integer seconds:

- `COMMIT_LOOKBACK_OVERLAP_SECONDS=900`
- `SYNC_POLL_INTERVAL_SECONDS=60`
- `SYNC_JOB_BUDGET_SECONDS=60`
- `SYNC_STALE_CLAIM_SECONDS=300`

Runtime preflight reports every invalid configured value at once. The parser
applies these defaults and never includes rejected values in error messages.

## Verification

The integration suites use
`@reviewpulse/db/integration-test-setup`, require migrated PostgreSQL, namespace
their fixtures, and remove their own `sync_jobs`, users, and enable rows. They
cover concurrent enqueue/schedule coalescing, atomic claims, attempt limits,
safe errors, stale recovery, all terminal statuses, distinct target discovery,
cursor boundaries, duplicate SHAs, interrupted pages, credential failover, and
terminal-state scheduling.
