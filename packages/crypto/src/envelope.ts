import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { buildPatAad, type SecretBinding } from "./aad.js";
import {
  DecryptionFailedError,
  EmptyPlaintextError,
  MalformedEnvelopeError,
  UnsupportedEnvelopeVersionError,
} from "./errors.js";
import type { EncryptionKeyLoader } from "./key-loader.js";

export const ENVELOPE_VERSION_V1 = 1;
export const ENVELOPE_ALGORITHM = "AES-256-GCM" as const;
export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;

const NODE_CIPHER = "aes-256-gcm" as const;

export type SealedSecret = {
  envelopeVersion: number;
  algorithm: typeof ENVELOPE_ALGORITHM;
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
};

/** Serialized transport/test form. DB stores the same fields as separate columns. */
export type PatEnvelopeV1 = {
  envelope_version: 1;
  algorithm: typeof ENVELOPE_ALGORITHM;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
};

export interface SecretSealer {
  seal(plaintext: string, binding: SecretBinding): Promise<SealedSecret>;
  open(sealed: SealedSecret, binding: SecretBinding): Promise<string>;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Accepts base64url with or without padding. */
function fromBase64Url(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedEnvelopeError();
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new MalformedEnvelopeError();
  }
  return Buffer.from(value, "base64url");
}

export function serializeEnvelope(sealed: SealedSecret): PatEnvelopeV1 {
  if (sealed.envelopeVersion !== ENVELOPE_VERSION_V1) {
    throw new UnsupportedEnvelopeVersionError();
  }
  return {
    envelope_version: ENVELOPE_VERSION_V1,
    algorithm: ENVELOPE_ALGORITHM,
    key_version: sealed.keyVersion,
    nonce: toBase64Url(sealed.nonce),
    ciphertext: toBase64Url(sealed.ciphertext),
    auth_tag: toBase64Url(sealed.authTag),
  };
}

export function parseEnvelope(input: unknown): SealedSecret {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MalformedEnvelopeError();
  }
  const raw = input as Record<string, unknown>;

  if (raw.envelope_version !== ENVELOPE_VERSION_V1) {
    if (
      typeof raw.envelope_version === "number" &&
      Number.isSafeInteger(raw.envelope_version)
    ) {
      throw new UnsupportedEnvelopeVersionError();
    }
    throw new MalformedEnvelopeError();
  }
  if (raw.algorithm !== ENVELOPE_ALGORITHM) {
    throw new MalformedEnvelopeError();
  }
  if (
    typeof raw.key_version !== "number" ||
    !Number.isSafeInteger(raw.key_version) ||
    raw.key_version < 1
  ) {
    throw new MalformedEnvelopeError();
  }

  const nonce = fromBase64Url(raw.nonce);
  const ciphertext = fromBase64Url(raw.ciphertext);
  const authTag = fromBase64Url(raw.auth_tag);
  assertEnvelopeShape(nonce, ciphertext, authTag);

  return {
    envelopeVersion: ENVELOPE_VERSION_V1,
    algorithm: ENVELOPE_ALGORITHM,
    keyVersion: raw.key_version,
    nonce,
    ciphertext,
    authTag,
  };
}

function assertEnvelopeShape(
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  authTag: Uint8Array,
): void {
  if (
    nonce.length !== NONCE_BYTES ||
    authTag.length !== AUTH_TAG_BYTES ||
    ciphertext.length === 0
  ) {
    throw new MalformedEnvelopeError();
  }
}

export class AesGcmSecretSealer implements SecretSealer {
  readonly #keys: EncryptionKeyLoader;

  constructor(keys: EncryptionKeyLoader) {
    this.#keys = keys;
  }

  async seal(plaintext: string, binding: SecretBinding): Promise<SealedSecret> {
    if (typeof plaintext !== "string" || plaintext.trim().length === 0) {
      throw new EmptyPlaintextError();
    }

    const { key, version } = this.#keys.currentKey();
    const nonce = randomBytes(NONCE_BYTES);
    const aad = buildPatAad({
      envelopeVersion: ENVELOPE_VERSION_V1,
      keyVersion: version,
      connectionId: binding.connectionId,
      credentialId: binding.credentialId,
    });

    const cipher = createCipheriv(NODE_CIPHER, key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);

    return {
      envelopeVersion: ENVELOPE_VERSION_V1,
      algorithm: ENVELOPE_ALGORITHM,
      keyVersion: version,
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
    };
  }

  async open(sealed: SealedSecret, binding: SecretBinding): Promise<string> {
    if (typeof sealed !== "object" || sealed === null) {
      throw new MalformedEnvelopeError();
    }
    if (sealed.envelopeVersion !== ENVELOPE_VERSION_V1) {
      throw new UnsupportedEnvelopeVersionError();
    }
    if (sealed.algorithm !== ENVELOPE_ALGORITHM) {
      throw new MalformedEnvelopeError();
    }
    assertEnvelopeShape(sealed.nonce, sealed.ciphertext, sealed.authTag);

    // Throws KeyVersionMismatchError when the row was sealed under another key.
    const { key, version } = this.#keys.keyForVersion(sealed.keyVersion);

    const aad = buildPatAad({
      envelopeVersion: sealed.envelopeVersion,
      keyVersion: version,
      connectionId: binding.connectionId,
      credentialId: binding.credentialId,
    });

    const decipher = createDecipheriv(NODE_CIPHER, key, sealed.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.authTag);

    let plaintext: Buffer;
    try {
      // final() verifies the tag; nothing is returned before it succeeds.
      plaintext = Buffer.concat([
        decipher.update(sealed.ciphertext),
        decipher.final(),
      ]);
    } catch {
      throw new DecryptionFailedError();
    }

    return plaintext.toString("utf8");
  }
}
