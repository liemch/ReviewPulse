/** WP1 — AES-256-GCM envelope, key loading, and redaction helpers. */

export {
  AAD_FIELD_SEPARATOR,
  buildPatAad,
  PAT_AAD_PURPOSE,
  type PatAadContext,
  type SecretBinding,
} from "./aad.js";
export {
  AesGcmSecretSealer,
  AUTH_TAG_BYTES,
  ENVELOPE_ALGORITHM,
  ENVELOPE_VERSION_V1,
  NONCE_BYTES,
  parseEnvelope,
  serializeEnvelope,
  type PatEnvelopeV1,
  type SealedSecret,
  type SecretSealer,
} from "./envelope.js";
export {
  CryptoError,
  DecryptionFailedError,
  EmptyPlaintextError,
  InvalidAadContextError,
  InvalidKeyMaterialError,
  InvalidKeyVersionError,
  isCryptoError,
  KeyVersionMismatchError,
  MalformedEnvelopeError,
  UnsupportedEnvelopeVersionError,
  type CryptoErrorCode,
} from "./errors.js";
export {
  createEnvKeyLoader,
  createStaticKeyLoader,
  decodeKeyMaterial,
  KEY_BYTES,
  parseKeyVersionLabel,
  type EncryptionKey,
  type EncryptionKeyLoader,
} from "./key-loader.js";
export {
  isSafeDomainError,
  isSensitiveKey,
  redact,
  redactHeaders,
  REDACTED,
  toSafeErrorPayload,
  type SafeDomainError,
  type SafeErrorPayload,
} from "./redact.js";

export const PACKAGE_NAME = "@reviewpulse/crypto" as const;
