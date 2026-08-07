# WP7 + WP7b + WP8 Execution Plan — Dashboard, metrics, hardening

Status: **IMPLEMENTED** on `feat/m1-wp7-dashboard-metrics`
Parent: `docs/PLAN-M1-Implementation.md`
Prerequisites: WP0–WP6 on `feat/m1-wp6-sync-worker`

## Scope

| Package | Delivered |
|---------|-----------|
| WP7b | Pure calculators (`commit_frequency`, `ai_assisted_commits`), stubs `loc_weekly`/`mr_size` `not_configured`, forbidden-field guard, seed `dev-kpi-ref-2026.08.1` |
| WP7 | `/dashboard`, authz-first `DashboardQueryService`, email aliases, disclaimer, deep links, MR terminology |
| WP8 | Dashboard IDOR + warm-cache fail-closed tests, snapshot immutability, PAT + encryption key runbooks |

## Out of scope

M2+, Playwright browser E2E harness, full LOC/MR numeric engines, TB-WP0 backlog, OAuth/Redis/webhooks/mutations/verdicts.

## Seed

```bash
npm run db:seed:kpi
```

Idempotent upsert of `KpiRuleSet` / `KpiRule` for role `DEV`, version `dev-kpi-ref-2026.08.1`.

## Acceptance mapping

- AC11: deep links + mismatch warnings without treating unverified aliases as confirmed KPI
- AC12–14: reference metrics only; LOC/MR `not_configured`; no score/grade/pass/fail
- AC15: no GitLab mutations
- AC16: unit + integration KPI/dashboard tests; runbooks for rotation

## E2E note

Browser Playwright is not wired in this repo. M1 sign-off uses PostgreSQL integration covering authz → dashboard → metrics (no verdict). Browser E2E can follow as DX.
