# Technical backlog — ReviewPulse M1

Non-blocking items deferred from reviews. Do **not** expand WP scope to clear these unless explicitly approved.

## From WP0 review (2026-08-05) — P2

| ID | Item | Suggested home | Notes |
|---|---|---|---|
| TB-WP0-01 | Align `.env.example` `DATABASE_URL` with Docker Compose local defaults (`reviewpulse:reviewpulse`) while keeping clear “local only” labeling | Docs/DX polish | Optional follow-up; not required for WP1 |
| TB-WP0-02 | Clarify or expand `wp0:check` vs CI (format/validate/migrate/smoke/build) | Root `package.json` / docs | Keep CI as source of truth until expanded |
| TB-WP0-03 | Remove unused `@reviewpulse/domain` dependency from worker if still unused | `apps/worker/package.json` | Re-add when WP6 sync needs domain types |
| TB-WP0-04 | Replace tautology worker test when worker has real behavior | `apps/worker` tests | Natural fit in WP6 |
| TB-WP0-05 | Add HTTP E2E for `/api/ready` in an appropriate package | `apps/web` or integration test | After local/CI Postgres always available for that job |

## Status legend

- **open** — accepted, not scheduled
- **scheduled** — assigned to a WP or polish pass
- **done** — fixed and verified

Current: all TB-WP0-* are **open**.
