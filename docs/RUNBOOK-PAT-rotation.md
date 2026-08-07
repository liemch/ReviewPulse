# Runbook — GitLab PAT rotation (M1)

## Goal

Replace a user’s GitLab Personal Access Token without exposing plaintext PAT
in logs, UI, or audit, and without ending the AppAuth session.

## When to use

- User reports GitLab 401 / “credential rejected”
- Connection status is `invalid`
- Scheduled PAT expiry
- Suspected token leak (rotate immediately; treat old token as compromised)

## Preconditions

- Operator or user can sign in to ReviewPulse (AppAuth session intact)
- GitLab instance is on the allowlist
- New PAT has `read_api` only (M1)

## Steps

1. Sign in to ReviewPulse (email/password). A GitLab 401 **must not** kill this session.
2. Open **Settings → GitLab**.
3. For the affected connection, use **Replace PAT** (or delete + re-add).
4. Paste the new PAT once. ReviewPulse encrypts it (AES-GCM + nonce + key_version) and stores only ciphertext.
5. Confirm connection status returns to **active** and identity binding is unchanged (`instance + gitlab_user_id`).
6. Open **Projects** and confirm allowlisted projects still list; re-enable if needed.
7. Ensure the worker is running so pending `project_sync` jobs resume.
8. On GitLab, revoke the **old** PAT.

## Verify

- Connection `status = active`
- Credential `status = active`, `invalidationReason` null
- Membership cache repopulates after probes (TTL 300s / negative TTL 30s)
- Sync jobs leave `sync_blocked` / complete successfully
- Audit shows connection/credential events **without** PAT, `PRIVATE-TOKEN`, ciphertext, or nonce

## Failure modes

| Symptom | Action |
|---------|--------|
| New PAT still 401 | Check scopes, instance URL allowlist, SSRF/internal flag |
| Projects empty after rotate | Wait for membership cache miss/expire or disable/re-enable project |
| Jobs stay `sync_blocked` | Confirm active credential; re-enable project; restart worker |

## Out of scope

- OAuth / SSO
- Showing historical plaintext PATs (impossible by design)
- Changing AppAuth password as part of PAT rotate
