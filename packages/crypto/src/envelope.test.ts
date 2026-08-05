import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { buildPatAad, PAT_AAD_PURPOSE } from "./aad.js";
import {
  AesGcmSecretSealer,
  AUTH_TAG_BYTES,
  ENVELOPE_ALGORITHM,
  ENVELOPE_VERSION_V1,
  NONCE_BYTES,
  parseEnvelope,
  serializeEnvelope,
  type SealedSecret,
} from "./envelope.js";
import { CryptoError } from "./errors.js";
import { createStaticKeyLoader, type EncryptionKeyLoader } from "./key-loader.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const PAT = "glpat-EXAMPLE-not-a-real-token-1234";

const BINDING = {
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaa",
  credentialId: "cred_aaaaaaaaaaaaaaaaaaaa",
};

function sealerWith(key: string, versionLabel = "v1"): AesGcmSecretSealer {
  return new AesGcmSecretSealer(createStaticKeyLoader(key, versionLabel));
}

/** Copy of `bytes` with one bit flipped at `index`. */
function flipByte(bytes: Uint8Array, index: number): Buffer {
  const copy = Buffer.from(bytes);
  copy.writeUInt8(copy.readUInt8(index) ^ 0x01, index);
  return copy;
}

async function expectCryptoError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<CryptoError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof CryptoError, `expected CryptoError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  return assert.fail(`expected ${code} to be thrown`);
}

describe("AesGcmSecretSealer", () => {
  it("roundtrips a PAT under the same key and binding", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);

    assert.equal(sealed.envelopeVersion, ENVELOPE_VERSION_V1);
    assert.equal(sealed.algorithm, ENVELOPE_ALGORITHM);
    assert.equal(sealed.keyVersion, 1);
    assert.equal(sealed.nonce.length, NONCE_BYTES);
    assert.equal(sealed.authTag.length, AUTH_TAG_BYTES);
    assert.equal(await sealer.open(sealed, BINDING), PAT);
  });

  it("never emits the plaintext inside the ciphertext bytes", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);
    const raw = Buffer.from(sealed.ciphertext).toString("utf8");
    const hex = Buffer.from(sealed.ciphertext).toString("hex");

    assert.ok(!raw.includes(PAT));
    assert.ok(!hex.includes(Buffer.from(PAT, "utf8").toString("hex")));
  });

  it("uses a fresh nonce and distinct ciphertext for every seal", async () => {
    const sealer = sealerWith(KEY_A);
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();

    for (let i = 0; i < 200; i += 1) {
      const sealed = await sealer.seal(PAT, BINDING);
      nonces.add(Buffer.from(sealed.nonce).toString("hex"));
      ciphertexts.add(Buffer.from(sealed.ciphertext).toString("hex"));
    }

    assert.equal(nonces.size, 200);
    assert.equal(ciphertexts.size, 200);
  });

  it("rejects an empty or whitespace-only secret before sealing", async () => {
    const sealer = sealerWith(KEY_A);
    await expectCryptoError(() => sealer.seal("", BINDING), "EMPTY_PLAINTEXT");
    await expectCryptoError(() => sealer.seal("   ", BINDING), "EMPTY_PLAINTEXT");
  });

  it("fails closed under a different key", async () => {
    const sealed = await sealerWith(KEY_A).seal(PAT, BINDING);
    await expectCryptoError(
      () => sealerWith(KEY_B).open(sealed, BINDING),
      "DECRYPTION_FAILED",
    );
  });

  it("fails closed when the row key version is not the configured version", async () => {
    const sealed = await sealerWith(KEY_A, "v2").seal(PAT, BINDING);
    assert.equal(sealed.keyVersion, 2);

    await expectCryptoError(
      () => sealerWith(KEY_A, "v1").open(sealed, BINDING),
      "KEY_VERSION_MISMATCH",
    );
  });

  it("fails closed on tampered ciphertext", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);
    const ciphertext = flipByte(sealed.ciphertext, 0);

    await expectCryptoError(
      () => sealer.open({ ...sealed, ciphertext }, BINDING),
      "DECRYPTION_FAILED",
    );
  });

  it("fails closed on a tampered auth tag", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);
    const authTag = flipByte(sealed.authTag, sealed.authTag.length - 1);

    await expectCryptoError(
      () => sealer.open({ ...sealed, authTag }, BINDING),
      "DECRYPTION_FAILED",
    );
  });

  it("fails closed on a tampered nonce", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);
    const nonce = flipByte(sealed.nonce, 0);

    await expectCryptoError(
      () => sealer.open({ ...sealed, nonce }, BINDING),
      "DECRYPTION_FAILED",
    );
  });

  it("rejects an unsupported envelope version", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);

    await expectCryptoError(
      () => sealer.open({ ...sealed, envelopeVersion: 2 }, BINDING),
      "UNSUPPORTED_ENVELOPE_VERSION",
    );
  });

  it("rejects malformed envelope shapes", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);

    await expectCryptoError(
      () =>
        sealer.open(
          { ...sealed, algorithm: "AES-128-GCM" } as unknown as SealedSecret,
          BINDING,
        ),
      "MALFORMED_ENVELOPE",
    );
    await expectCryptoError(
      () => sealer.open({ ...sealed, nonce: Buffer.alloc(8) }, BINDING),
      "MALFORMED_ENVELOPE",
    );
    await expectCryptoError(
      () => sealer.open({ ...sealed, authTag: Buffer.alloc(4) }, BINDING),
      "MALFORMED_ENVELOPE",
    );
    await expectCryptoError(
      () => sealer.open({ ...sealed, ciphertext: Buffer.alloc(0) }, BINDING),
      "MALFORMED_ENVELOPE",
    );
    await expectCryptoError(
      () => sealer.open(null as unknown as SealedSecret, BINDING),
      "MALFORMED_ENVELOPE",
    );
  });

  it("cannot open a ciphertext moved to another connection", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);

    await expectCryptoError(
      () =>
        sealer.open(sealed, {
          connectionId: "conn_bbbbbbbbbbbbbbbbbbbb",
          credentialId: BINDING.credentialId,
        }),
      "DECRYPTION_FAILED",
    );
  });

  it("cannot open a ciphertext moved to another credential row", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);

    await expectCryptoError(
      () =>
        sealer.open(sealed, {
          connectionId: BINDING.connectionId,
          credentialId: "cred_bbbbbbbbbbbbbbbbbbbb",
        }),
      "DECRYPTION_FAILED",
    );
  });

  it("rejects an invalid AAD binding instead of guessing", async () => {
    const sealer = sealerWith(KEY_A);
    await expectCryptoError(
      () => sealer.seal(PAT, { connectionId: "", credentialId: "cred_1" }),
      "INVALID_AAD_CONTEXT",
    );
    await expectCryptoError(
      () =>
        sealer.seal(PAT, {
          connectionId: "conn|injected",
          credentialId: "cred_1",
        }),
      "INVALID_AAD_CONTEXT",
    );
  });

  it("keeps plaintext and key material out of thrown errors", async () => {
    const sealed = await sealerWith(KEY_A).seal(PAT, BINDING);
    const error = await expectCryptoError(
      () => sealerWith(KEY_B).open(sealed, BINDING),
      "DECRYPTION_FAILED",
    );

    const serialized = `${error.message}${JSON.stringify(error)}${error.stack ?? ""}`;
    assert.ok(!serialized.includes(PAT));
    assert.ok(!serialized.includes(KEY_A));
    assert.ok(!serialized.includes(KEY_B));
  });
});

describe("envelope serialization", () => {
  it("roundtrips through the base64url wire form", async () => {
    const sealer = sealerWith(KEY_A);
    const sealed = await sealer.seal(PAT, BINDING);
    const wire = serializeEnvelope(sealed);

    assert.equal(wire.envelope_version, 1);
    assert.equal(wire.algorithm, "AES-256-GCM");
    assert.equal(wire.key_version, 1);
    assert.match(wire.nonce, /^[A-Za-z0-9_-]+$/);
    assert.match(wire.ciphertext, /^[A-Za-z0-9_-]+$/);
    assert.match(wire.auth_tag, /^[A-Za-z0-9_-]+$/);

    assert.equal(await sealer.open(parseEnvelope(wire), BINDING), PAT);
  });

  it("rejects malformed wire envelopes", async () => {
    const wire = serializeEnvelope(await sealerWith(KEY_A).seal(PAT, BINDING));

    assert.throws(() => parseEnvelope("not-an-object"), { code: "MALFORMED_ENVELOPE" });
    assert.throws(() => parseEnvelope([wire]), { code: "MALFORMED_ENVELOPE" });
    assert.throws(() => parseEnvelope({ ...wire, envelope_version: 9 }), {
      code: "UNSUPPORTED_ENVELOPE_VERSION",
    });
    assert.throws(() => parseEnvelope({ ...wire, key_version: 0 }), {
      code: "MALFORMED_ENVELOPE",
    });
    assert.throws(() => parseEnvelope({ ...wire, nonce: "!!!" }), {
      code: "MALFORMED_ENVELOPE",
    });
    assert.throws(() => parseEnvelope({ ...wire, auth_tag: undefined }), {
      code: "MALFORMED_ENVELOPE",
    });
  });
});

describe("buildPatAad", () => {
  it("produces the locked canonical form", () => {
    const aad = buildPatAad({
      envelopeVersion: 1,
      keyVersion: 1,
      connectionId: "conn_1",
      credentialId: "cred_1",
    }).toString("utf8");

    assert.equal(
      aad,
      `${PAT_AAD_PURPOSE}|v1|kv1|connection:conn_1|credential:cred_1`,
    );
  });

  it("rejects non-positive versions", () => {
    assert.throws(
      () =>
        buildPatAad({
          envelopeVersion: 0,
          keyVersion: 1,
          connectionId: "conn_1",
          credentialId: "cred_1",
        }),
      { code: "INVALID_AAD_CONTEXT" },
    );
  });
});

describe("key loader injection", () => {
  it("accepts any loader implementing the interface", async () => {
    const key = Buffer.from(KEY_A, "base64");
    const loader: EncryptionKeyLoader = {
      currentKey: () => ({ version: 7, key }),
      keyForVersion: (version) => {
        assert.equal(version, 7);
        return { version: 7, key };
      },
    };
    const sealer = new AesGcmSecretSealer(loader);
    const sealed = await sealer.seal(PAT, BINDING);

    assert.equal(sealed.keyVersion, 7);
    assert.equal(await sealer.open(sealed, BINDING), PAT);
  });
});
