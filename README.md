# ReviewPulse

GitLab KPI visibility for engineering teams (M1: read-only).

## Prerequisites

- Node.js 24.x and npm ≥ 11 (see `.nvmrc` / `packageManager`)
- PostgreSQL 16+ listening locally (default `localhost:5432`)
- A monorepo-root `.env` (gitignored) — copy from `.env.example` and fill real values

## Local environment

All apps (`web`, `worker`) and Prisma load configuration from the **monorepo root** `.env` via `loadMonorepoEnv()`. Do **not** commit secrets; do **not** put usable keys in `.env.example`.

### Required keys (WP3+)

| Key | Rule (values never logged) |
|---|---|
| `DATABASE_URL` | `postgresql://…` or `postgres://…` |
| `SESSION_SECRET` | ≥ 32 characters |
| `TOKEN_ENCRYPTION_KEY` | Canonical standard Base64 decoding to exactly 32 bytes |
| `TOKEN_ENCRYPTION_KEY_VERSION` | `v` + positive integer (e.g. `v1`) |
| `APP_ORIGIN` | Bare origin for CSRF checks (e.g. `http://localhost:3000`) |

`GITLAB_URL_ALLOWLIST` is optional for the Settings UI — WP4 stores instance allowlist rows in PostgreSQL. If the env var is set, each entry must be an `http(s)` origin (`internal:` prefix allowed for private networks).

Do **not** set `NODE_ENV` in `.env`. Next.js and npm scripts own it (`development` for `dev`, `production` for `build`/`start`).

### Preflight

Reports **every** missing/invalid key in one shot (keys + messages only):

```bash
npm run env:preflight
```

Web (`next.config` + `instrumentation`) and the worker run the same checks on startup.

## Database

```bash
npm run db:generate
npm run db:migrate:deploy
npm run db:migrate:status
npm run db:ready-smoke
```

Additive migrations only — never reset/drop for routine local work.

## Run the web app

```bash
npm run env:preflight
npm run dev:web
```

Web scripts preload the monorepo-root `.env` via `apps/web/scripts/preload-env.mjs` (Node-only — not bundled by webpack). Worker / Prisma / CLI use `loadMonorepoEnv()` from `@reviewpulse/db/load-env` (not the main `@reviewpulse/db` barrel).

Smoke endpoints:

- `GET /api/health` → 200
- `GET /api/ready` → 200 when PostgreSQL is reachable
- `GET /login` → invite-only sign-in form

## Bootstrap the first admin (CLI only)

There is **no** public signup and **no** HTTP bootstrap endpoint.

```bash
# Write the password to a file you control (never commit it).
printf '%s' 'your-long-password' > /tmp/rp-admin-password.txt
chmod 600 /tmp/rp-admin-password.txt

npm run auth:bootstrap-admin -- \
  --email admin@example.com \
  --password-file /tmp/rp-admin-password.txt

rm -f /tmp/rp-admin-password.txt
```

Then open `/login`, sign in, and use `/settings/*` (GitLab connection, projects, admin users/allowlist).

## Sync worker

```bash
npm run dev:worker
```

The WP6 worker loads the root `.env`, checks PostgreSQL readiness, coalesces
enabled projects into PostgreSQL jobs, and incrementally syncs read-only GitLab
commit/MR caches. Stop it with `SIGINT` or `SIGTERM`.
Runtime/cursor locks are documented in `docs/PLAN-M1-WP6-Execution.md`.

## Quality gates

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm audit
npm audit --omit=dev
```

`npm run test` loads the monorepo root `.env` and requires the migrated local
PostgreSQL database. Missing, invalid, or unreachable `DATABASE_URL` fails the
integration suites instead of silently skipping them.

## Docs

- Spec: `docs/SPEC-ReviewPulse-M1-M4.md`
- Plan: `docs/PLAN-M1-Implementation.md`
- WP3+WP4 execution: `docs/PLAN-M1-WP3-WP4-Execution.md`
