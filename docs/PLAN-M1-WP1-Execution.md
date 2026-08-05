# WP1 Execution Plan — Crypto + GitLab credentials

Status: **PASS** — 2026-08-05 (merged to main; CI green)  
Parent: `docs/PLAN-M1-Implementation.md` (APPROVED)  
Prerequisite: **WP0 = PASS**  
Branch: `feat/m1-wp1-crypto-credentials` (merged)

Locks below were implemented as written. Migration applied via `20260805120000_wp1_credential_envelope`.

---

## 1. AES-256-GCM envelope (locked)

| Field | Type / encoding | Notes |
|---|---|---|
| `envelope_version` | `uint8` / int, currently **`1`** | Reject unknown versions fail-closed |
| `algorithm` | constant `AES-256-GCM` | Stored/validated; not configurable per record |
| `key_version` | positive int (from env mapping) | Must match loaded key |
| `nonce` | 12 random bytes → **base64url** in serialized envelope; **BYTEA** in DB | `crypto.randomBytes(12)` per seal |
| `ciphertext` | bytes → base64url / BYTEA | From `cipher.update` + `cipher.final` only |
| `auth_tag` | 16 bytes (GCM default) → base64url / BYTEA | From `cipher.getAuthTag()`; **verify before plaintext** |

**Library:** Node.js built-in `node:crypto` only (`createCipheriv` / `createDecipheriv` with `aes-256-gcm`).

**Rules:**
- Key must be exactly **32 bytes** after base64 decode.
- Nonce **never reused** with the same key (fresh 12 bytes every seal).
- Malformed envelope, unknown `envelope_version`, wrong `key_version`, wrong key, auth-tag mismatch, AAD mismatch → **typed error**, **no partial plaintext**.
- Encoding for any serialized/transport representation: **base64url** (no padding preferred; document decode that accepts both).

Serialized envelope shape (in-memory / tests; DB may store columns denormalized):

```ts
type PatEnvelopeV1 = {
  envelope_version: 1;
  algorithm: "AES-256-GCM";
  key_version: number;
  nonce: string;      // base64url
  ciphertext: string; // base64url
  auth_tag: string;   // base64url
};
```

---

## 2. AAD (locked)

AES-GCM **Additional Authenticated Data** is mandatory to prevent ciphertext copy/swap across records.

**Canonical AAD string (UTF-8 bytes):**

```text
reviewpulse:gitlab-pat|v{envelope_version}|kv{key_version}|connection:{connectionId}|credential:{credentialId}
```

Example:

```text
reviewpulse:gitlab-pat|v1|kv1|connection:clx...|credential:cly...
```

**Rules:**
- Purpose/domain constant prefix: `reviewpulse:gitlab-pat` (fixed).
- Always bind `connectionId` and `credentialId` (generate credential cuid **before** seal, then insert).
- Bind `envelope_version` and `key_version` in AAD.
- On open: rebuild AAD **only** from trusted DB row context (connection id + credential id + versions on the row), never from attacker-controlled envelope alone for those IDs.
- Ciphertext sealed for Connection A **must fail** open under Connection B / different credential id / tampered AAD.

---

## 3. Key loading & versioning (locked)

| Env | Format | Notes |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | **canonical** standard base64 of exactly **32** random bytes | Strict decode: no trimming or normalization; reject non-alphabet characters, malformed padding, any whitespace (including a trailing newline), wrong decoded length, and any input that does not survive a decode/encode round trip unchanged |
| `TOKEN_ENCRYPTION_KEY_VERSION` | string label e.g. `v1` | Maps to integer `key_version` stored on rows (`v1` → `1`) |

**M1/WP1 single-key policy (documented limit):**
- Loader returns the **current** key for `TOKEN_ENCRYPTION_KEY_VERSION` only.
- Decrypt succeeds **only** when row `key_version` matches the configured current version.
- **Not in WP1:** multi-key ring, decrypt-old/re-encrypt-new, full master-key rotation workflow.
- Distinguish clearly:
  - **PAT rotation** = `replaceCredential` (new sealed PAT; old credential `superseded`) — **in WP1**.
  - **Encryption-key rotation** = change master key / re-wrap — **future hardening**, do not claim done in WP1.

**Ops:**
- Never log key, decoded key bytes, or key fingerprint.
- Key loader **injectable** in unit tests.
- `.env.example`: placeholders + format comments only; empty values; no usable real key.

---

## 4. Persistence shape — current schema vs required

### Current `UserCredential` (WP0)

| Column | Present? |
|---|---|
| `ciphertext` | Yes (`Bytes`) |
| `nonce` | Yes (`Bytes`) |
| `key_version` | Yes (`Int`) |
| `pat_hint_last4` | Yes |
| `status` | Yes (`active\|invalid\|superseded\|revoked`) |
| `validated_at` / `revoked_at` | Yes (optional timestamps) |
| **`auth_tag`** | **MISSING** |
| **`envelope_version`** | **MISSING** |
| **`invalidation_reason`** | **MISSING** (only status + timestamps) |

**No plaintext PAT column** (good — keep it that way).

### Shipped additive, non-destructive migration

`packages/db/prisma/migrations/20260805120000_wp1_credential_envelope/migration.sql`:

```prisma
// additive fields on UserCredential
authTag          Bytes   @map("auth_tag")
envelopeVersion  Int     @default(1) @map("envelope_version")
invalidationReason CredentialInvalidationReason? @map("invalidation_reason")
```

```prisma
enum CredentialInvalidationReason {
  gitlab_unauthorized   // GitLab 401 / token no longer authenticates
  expired               // optional hint if expiry known
  user_revoked          // explicit revoke in ReviewPulse
  user_deleted
  connection_deleted
}
```

**Status vs reason mapping (locked):**

| Event | `status` | `invalidation_reason` | Timestamp |
|---|---|---|---|
| New / current PAT | `active` | null | — |
| Replaced by newer PAT | `superseded` | null | — |
| GitLab 401 / unusable token | `invalid` | `gitlab_unauthorized` (or `expired` if known) | `revoked_at` or dedicated invalidated_at if added; use `revoked_at` as “ended_at” for simplicity in WP1 **or** leave `revoked_at` only for revoke — prefer set `revoked_at` when leaving active for invalid/revoked |
| User/admin revoke in RP | `revoked` | `user_revoked` | `revoked_at` |
| User deleted | `revoked` | `user_deleted` | `revoked_at` |
| Connection deleted | `revoked` | `connection_deleted` | `revoked_at` |

Do **not** invent free-form status strings. Do **not** reactivate `superseded` / `revoked` / `invalid` rows.

**Auth tag storage:** separate `auth_tag BYTEA` column (not concatenated into `ciphertext`) so envelope fields stay explicit.

---

## 5. `PatCredentialProvider` contract (locked)

Internal server-side only — **no** route handlers, HTTP API, or UI in WP1.

```ts
type InvalidateReason =
  | "gitlab_unauthorized"
  | "expired"
  | "user_revoked"
  | "user_deleted"
  | "connection_deleted";

interface PatCredentialProvider {
  storeCredential(connectionId: string, pat: string): Promise<{ credentialId: string; patHintLast4: string }>;
  getAccessToken(connectionId: string): Promise<string>; // active credential only
  replaceCredential(connectionId: string, newPat: string): Promise<{ credentialId: string; patHintLast4: string }>;
  invalidateCredential(connectionId: string, reason: InvalidateReason): Promise<void>;
}
```

**`getAccessToken`:**
- Returns plaintext PAT string to trusted server callers only.
- Does **not** return envelope, nonce, tag, ciphertext, or key material.
- No long-lived plaintext cache (decrypt per call or short ephemeral in-call only).
- Never attach PAT to thrown errors.

**PAT input policy — validate, never normalize** (`assertValidPat`). Rejected with typed `INVALID_PAT` before any transaction opens, for both `storeCredential` and `replaceCredential`:
- non-string, empty, or whitespace-only;
- `pat !== pat.trim()` (leading/trailing whitespace is a copy-paste accident, not a token);
- any C0 control character or DEL anywhere, covering tab, newline, and carriage return.

The sealed plaintext is byte-for-byte the validated string, and `pat_hint_last4` is the last four characters of that same string — no separate trim, so the hint always describes exactly what was sealed. The error message is a constant; the input and the rejected portion never appear in errors or logs.

Align package exports with this contract (may extend WP0 stub `GitLabCredentialProvider` or wrap it — prefer explicit methods above as the WP1 surface; keep interface name stable where possible).

---

## 6. Atomic replace / rotate (locked)

`replaceCredential` in a **single DB transaction**:

1. `BEGIN`
2. Lock active credential for connection: e.g. `SELECT … WHERE connection_id = $id AND status = 'active' FOR UPDATE` (serialize per connection).
3. Mark old row `status = superseded` (if any).
4. Generate new credential id → seal PAT with AAD bound to that id + connection id → `INSERT` active row.
5. `COMMIT` (or full rollback).

**Invariants:**
- After commit: **at most one** `active` credential per connection (also enforced by partial unique index `user_credentials_one_active_per_connection`).
- If insert fails: old active remains (rollback).
- Concurrent replace: unique violation → typed domain error (e.g. `ConcurrentCredentialReplaceError`); **no** SQL text, PAT, or ciphertext in error.
- Integration test for concurrent/duplicate active when Postgres test env available (CI).

---

## 7. Invalidation semantics (locked)

- Idempotent: second `invalidateCredential` on already non-active → no-op success.
- Never move `superseded` / `revoked` / `invalid` back to `active`.
- Prefer updating the **current active** credential for the connection; if none active, no-op.

---

## 8. Redaction (locked)

Deep redact (clone; do not mutate input when avoidable) keys including (case-insensitive match on object keys / header names):

`authorization`, `private-token`, `pat`, `token`, `access_token`, `encrypted_pat`, `ciphertext`, `nonce`, `auth_tag`, `session`, `password`, `secret`, plus `TOKEN_ENCRYPTION_KEY`.

- Nested objects and arrays.
- Not solely regex-on-log-string.
- Production/domain errors: typed `code` + safe `message` only.
- `pat_hint_last4` may exist in return metadata; **do not log last4 by default**.

---

## 9. Mandatory tests (locked)

**Crypto unit:**
- roundtrip; unique nonce; wrong key; wrong key version; tampered ciphertext; tampered tag; malformed envelope; wrong AAD/connection; empty PAT rejected; key format/length validation.

**Credential integration (Postgres):**
- no plaintext PAT in DB columns after store;
- store/load; replace supersedes old; rollback if insert fails;
- at most one active; invalidate idempotent; status/reason mapping;
- errors never contain PAT/ciphertext.

**Regression:**
- `npm audit --omit=dev` clean;
- lint / typecheck / test / build;
- CI migrate apply if schema additive migration ships.

---

## 10. Files expected at implement time

| Path | Role |
|---|---|
| `packages/crypto/src/**` | Envelope seal/open, key loader, typed errors, redaction helper (or shared) |
| `packages/credentials/src/**` | `PatCredentialProvider` + transactions |
| `packages/db/prisma/schema.prisma` + additive migration | `auth_tag`, `envelope_version`, `invalidation_reason` (+ enum) |
| `.env.example` | `TOKEN_ENCRYPTION_KEY` + `TOKEN_ENCRYPTION_KEY_VERSION` placeholders |
| Tests under crypto/credentials (+ CI uses Postgres) | As above |

---

## Updated implement prompt (copy when approved)

```text
Implement WP1 only per docs/PLAN-M1-WP1-Execution.md (LOCKED) and docs/PLAN-M1-Implementation.md (APPROVED). WP0 = PASS.

Branch: create feat/m1-wp1-crypto-credentials from latest main.

IN:
- node:crypto AES-256-GCM envelope v1 (envelope_version, algorithm, key_version, nonce 12B, ciphertext, auth_tag); base64url encoding; typed fail-closed errors; no partial plaintext.
- Mandatory AAD: reviewpulse:gitlab-pat|v{envelope}|kv{key}|connection:{id}|credential:{id}; tests for cross-connection swap / wrong AAD.
- Key: TOKEN_ENCRYPTION_KEY = base64 of exactly 32 bytes; TOKEN_ENCRYPTION_KEY_VERSION (e.g. v1→1); injectable loader; single-key decrypt only (document no full master-key rotation).
- Additive non-destructive Prisma migration: auth_tag, envelope_version, invalidation_reason enum; never store plaintext PAT.
- PatCredentialProvider: storeCredential, getAccessToken(connectionId), replaceCredential (transactional supersede+insert), invalidateCredential (idempotent); no HTTP/UI.
- Redaction utility + tests (nested/array/headers/errors).
- Full unit + Postgres integration tests listed in execution plan.

OUT:
- AppAuth/sessions/CSRF/UI, GitLab HTTP/SSRF, WP2+, OAuth/SSO/Redis/webhook/AI/NVIDIA/mutations.
- Do not clear TB-WP0-* backlog unless separately approved.
- Any scope change: stop and ask.

Acceptance: execution-plan checklist + CI green including migration if schema changed. Stop — do not start WP2.
```

---

## Decision summary (for approval)

| Topic | Decision |
|---|---|
| Schema enough today? | **No** — missing `auth_tag`, `envelope_version`, `invalidation_reason` (+ enum). Additive migration required in WP1 implement. |
| Key format | Base64 → exactly 32 bytes; version label `TOKEN_ENCRYPTION_KEY_VERSION=v1` → int `1` |
| AAD | `reviewpulse:gitlab-pat\|v{n}\|kv{n}\|connection:{id}\|credential:{id}` |
| Transaction | `FOR UPDATE` active row → supersede → insert new active → commit/rollback; unique violation → domain error |
| Status/reason | Use existing `CredentialStatus` + new `CredentialInvalidationReason`; mapping table above |
| Tests | Crypto unit + credential integration + audit/lint/typecheck/test/build (+ migrate on CI) |
