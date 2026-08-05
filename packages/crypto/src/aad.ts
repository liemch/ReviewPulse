import { Buffer } from "node:buffer";

import { InvalidAadContextError } from "./errors.js";

/** Fixed domain separator: a PAT envelope can never be opened as another purpose. */
export const PAT_AAD_PURPOSE = "reviewpulse:gitlab-pat" as const;

export const AAD_FIELD_SEPARATOR = "|" as const;

/** Row identity a sealed PAT is bound to. Rebuilt from trusted DB context on open. */
export type SecretBinding = {
  connectionId: string;
  credentialId: string;
};

export type PatAadContext = SecretBinding & {
  envelopeVersion: number;
  keyVersion: number;
};

function assertBindingId(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes(AAD_FIELD_SEPARATOR)
  ) {
    throw new InvalidAadContextError();
  }
  return value;
}

function assertVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidAadContextError();
  }
  return value;
}

/**
 * `reviewpulse:gitlab-pat|v{envelope}|kv{key}|connection:{id}|credential:{id}`
 *
 * Binding both ids makes a ciphertext copied onto another connection or
 * credential row fail authentication instead of decrypting.
 */
export function buildPatAad(context: PatAadContext): Buffer {
  const envelopeVersion = assertVersion(context.envelopeVersion);
  const keyVersion = assertVersion(context.keyVersion);
  const connectionId = assertBindingId(context.connectionId);
  const credentialId = assertBindingId(context.credentialId);

  const canonical = [
    PAT_AAD_PURPOSE,
    `v${envelopeVersion}`,
    `kv${keyVersion}`,
    `connection:${connectionId}`,
    `credential:${credentialId}`,
  ].join(AAD_FIELD_SEPARATOR);

  return Buffer.from(canonical, "utf8");
}
