import { Buffer } from "node:buffer";

import {
  InvalidKeyMaterialError,
  InvalidKeyVersionError,
  KeyVersionMismatchError,
} from "./errors.js";

export const KEY_BYTES = 32;

export type EncryptionKey = {
  version: number;
  key: Buffer;
};

export interface EncryptionKeyLoader {
  /** Key used for every new seal. */
  currentKey(): EncryptionKey;
  /**
   * WP1 single-key policy: only the current version can be opened.
   * A key ring with decrypt-old / re-encrypt-new is future hardening.
   */
  keyForVersion(version: number): EncryptionKey;
}

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_VERSION_LABEL = /^v?(\d+)$/i;

/** `v1` -> 1. Rejects zero, negatives, and free-form labels. */
export function parseKeyVersionLabel(label: string): number {
  if (typeof label !== "string") {
    throw new InvalidKeyVersionError();
  }
  const match = KEY_VERSION_LABEL.exec(label.trim());
  if (!match?.[1]) {
    throw new InvalidKeyVersionError();
  }
  const version = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new InvalidKeyVersionError();
  }
  return version;
}

/**
 * Canonical standard base64 decoding to exactly 32 bytes.
 *
 * Nothing is trimmed or normalized: `Buffer.from(_, "base64")` silently drops
 * characters it does not recognise, so a permissive decode would accept a
 * typo'd or whitespace-padded key and derive a different 32 bytes than the
 * operator intended. The input must survive a decode/encode round trip
 * unchanged.
 */
export function decodeKeyMaterial(encoded: string): Buffer {
  if (typeof encoded !== "string") {
    throw new InvalidKeyMaterialError();
  }
  if (encoded.length === 0 || !STANDARD_BASE64.test(encoded)) {
    throw new InvalidKeyMaterialError();
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== encoded) {
    throw new InvalidKeyMaterialError();
  }
  return key;
}

/** Injectable in tests; never logs or exposes key bytes or a fingerprint. */
export function createStaticKeyLoader(
  encodedKey: string,
  versionLabel: string,
): EncryptionKeyLoader {
  const key = decodeKeyMaterial(encodedKey);
  const version = parseKeyVersionLabel(versionLabel);

  return {
    currentKey() {
      return { version, key };
    },
    keyForVersion(requested: number) {
      if (requested !== version) {
        throw new KeyVersionMismatchError();
      }
      return { version, key };
    },
  };
}

export function createEnvKeyLoader(
  env: NodeJS.ProcessEnv = process.env,
): EncryptionKeyLoader {
  const encodedKey = env.TOKEN_ENCRYPTION_KEY;
  const versionLabel = env.TOKEN_ENCRYPTION_KEY_VERSION;
  if (!encodedKey) {
    throw new InvalidKeyMaterialError();
  }
  if (!versionLabel) {
    throw new InvalidKeyVersionError();
  }
  return createStaticKeyLoader(encodedKey, versionLabel);
}
