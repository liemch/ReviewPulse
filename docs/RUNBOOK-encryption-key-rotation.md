# Runbook — Encryption key rotation (M1)

## Goal

Introduce a new `TOKEN_ENCRYPTION_KEY` version so newly sealed PATs use the
new key, while old ciphertext remains decryptable until re-sealed — or fail
closed if the old key is retired without re-encryption.

## Model

- Credentials store `key_version` with ciphertext, nonce, and auth tag.
- The sealer loads keys from environment (see `@reviewpulse/crypto` env key loader).
- Decrypt selects the key matching `key_version`. Missing key → fail closed (no plaintext leak).

## Preconditions

- Access to deploy secrets / `.env` (never commit keys)
- Maintenance window if retiring the previous key
- Database backup recommended before bulk re-seal

## Rotate forward (add new version)

1. Generate a new 32-byte key (base64).
2. Add it to the runtime env under the next `key_version` supported by the loader.
3. Keep the previous key available under its existing version.
4. Redeploy web + worker.
5. Ask users (or an admin script) to **Replace PAT** so new envelopes use the new `key_version`.
6. Confirm new `user_credentials.key_version` values match the new version.

## Retire an old key

1. Ensure **no** active credential rows still reference the old `key_version`.
2. Remove the old key material from the environment.
3. Redeploy.
4. Smoke: decrypt of a remaining old envelope must fail closed; login/session still works; GitLab settings show invalid/connection error — not a stack trace with ciphertext.

## Verify

- `npm run env:preflight` passes
- Login + CSRF still work (AppAuth uses `SESSION_SECRET`, separate from PAT keys)
- Replace PAT succeeds and sync resumes
- Logs never contain key material, ciphertext, nonce, or auth tags

## Failure modes

| Symptom | Action |
|---------|--------|
| All connections suddenly invalid | Old key removed too early — restore previous key version temporarily |
| Env preflight fails | Check key length/encoding; do not paste keys into tickets |
| Worker cannot decrypt | Deploy the same key set to worker and web |

## Out of scope

- Transparent online re-encryption of all rows without user replace (not required for M1)
- Sharing encryption keys in chat/email
