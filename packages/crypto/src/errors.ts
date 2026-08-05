/**
 * Typed, fail-closed crypto errors.
 *
 * Messages are fixed constants: never interpolate plaintext, key material,
 * ciphertext, nonce, or auth tag into an error that may be logged or serialized.
 */

export type CryptoErrorCode =
  | "INVALID_KEY_MATERIAL"
  | "INVALID_KEY_VERSION"
  | "KEY_VERSION_MISMATCH"
  | "UNSUPPORTED_ENVELOPE_VERSION"
  | "MALFORMED_ENVELOPE"
  | "INVALID_AAD_CONTEXT"
  | "DECRYPTION_FAILED"
  | "EMPTY_PLAINTEXT";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  /** Message is a fixed constant, so it is safe to surface outside the process. */
  readonly safeForClient = true as const;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

export class InvalidKeyMaterialError extends CryptoError {
  constructor() {
    super(
      "INVALID_KEY_MATERIAL",
      "Encryption key must be standard base64 decoding to exactly 32 bytes",
    );
    this.name = "InvalidKeyMaterialError";
  }
}

export class InvalidKeyVersionError extends CryptoError {
  constructor() {
    super(
      "INVALID_KEY_VERSION",
      "Encryption key version must be a positive integer label such as v1",
    );
    this.name = "InvalidKeyVersionError";
  }
}

export class KeyVersionMismatchError extends CryptoError {
  constructor() {
    super(
      "KEY_VERSION_MISMATCH",
      "Sealed secret key version does not match the configured current key version",
    );
    this.name = "KeyVersionMismatchError";
  }
}

export class UnsupportedEnvelopeVersionError extends CryptoError {
  constructor() {
    super("UNSUPPORTED_ENVELOPE_VERSION", "Unsupported envelope version");
    this.name = "UnsupportedEnvelopeVersionError";
  }
}

export class MalformedEnvelopeError extends CryptoError {
  constructor() {
    super("MALFORMED_ENVELOPE", "Sealed secret envelope is malformed");
    this.name = "MalformedEnvelopeError";
  }
}

export class InvalidAadContextError extends CryptoError {
  constructor() {
    super(
      "INVALID_AAD_CONTEXT",
      "Additional authenticated data context is missing or invalid",
    );
    this.name = "InvalidAadContextError";
  }
}

export class DecryptionFailedError extends CryptoError {
  constructor() {
    super("DECRYPTION_FAILED", "Sealed secret failed authenticated decryption");
    this.name = "DecryptionFailedError";
  }
}

export class EmptyPlaintextError extends CryptoError {
  constructor() {
    super("EMPTY_PLAINTEXT", "Secret must be a non-empty string");
    this.name = "EmptyPlaintextError";
  }
}

export function isCryptoError(value: unknown): value is CryptoError {
  return value instanceof CryptoError;
}
