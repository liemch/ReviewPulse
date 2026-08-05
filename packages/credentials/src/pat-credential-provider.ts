import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  ENVELOPE_ALGORITHM,
  isCryptoError,
  type SealedSecret,
  type SecretSealer,
} from "@reviewpulse/crypto";
import type { PrismaClient } from "@reviewpulse/db";

import {
  ActiveCredentialExistsError,
  ConcurrentCredentialReplaceError,
  ConnectionNotFoundError,
  CredentialStoreFailedError,
  CredentialUnreadableError,
  InvalidInvalidationReasonError,
  isForeignKeyViolation,
  isUniqueViolation,
  NoActiveCredentialError,
} from "./errors.js";
import { assertValidPat, patHintLast4 } from "./pat-policy.js";

/** Mirrors Prisma's interactive transaction client without importing the namespace. */
type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export type InvalidateReason =
  | "gitlab_unauthorized"
  | "expired"
  | "user_revoked"
  | "user_deleted"
  | "connection_deleted";

/** Locked status mapping — no free-form status strings. */
const REASON_TO_STATUS = {
  gitlab_unauthorized: "invalid",
  expired: "invalid",
  user_revoked: "revoked",
  user_deleted: "revoked",
  connection_deleted: "revoked",
} as const satisfies Record<InvalidateReason, "invalid" | "revoked">;

export type StoredCredentialRef = {
  credentialId: string;
  patHintLast4: string;
};

/**
 * Server-side only. No route handler, HTTP response, or UI may consume
 * `getAccessToken` output directly — WP1 ships no transport at all.
 */
export interface PatCredentialProvider {
  storeCredential(connectionId: string, pat: string): Promise<StoredCredentialRef>;
  getAccessToken(connectionId: string): Promise<string>;
  replaceCredential(
    connectionId: string,
    newPat: string,
  ): Promise<StoredCredentialRef>;
  invalidateCredential(
    connectionId: string,
    reason: InvalidateReason,
  ): Promise<void>;
}

/** OAuth-backed providers in a later milestone implement the same surface. */
export type GitLabCredentialProvider = PatCredentialProvider;

export type PatCredentialProviderDeps = {
  prisma: PrismaClient;
  sealer: SecretSealer;
};

function toSealed(row: {
  envelopeVersion: number;
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}): SealedSecret {
  return {
    envelopeVersion: row.envelopeVersion,
    algorithm: ENVELOPE_ALGORITHM,
    keyVersion: row.keyVersion,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.authTag,
  };
}

export class PrismaPatCredentialProvider implements PatCredentialProvider {
  readonly #prisma: PrismaClient;
  readonly #sealer: SecretSealer;

  constructor(deps: PatCredentialProviderDeps) {
    this.#prisma = deps.prisma;
    this.#sealer = deps.sealer;
  }

  /**
   * First credential for a connection. Fails closed when one is already active
   * so a caller cannot create a second active row by mistake — rotation goes
   * through `replaceCredential`.
   */
  async storeCredential(
    connectionId: string,
    pat: string,
  ): Promise<StoredCredentialRef> {
    // Validated before any transaction opens, so a rejected PAT never touches the DB.
    const secret = assertValidPat(pat);

    return this.#prisma.$transaction(async (tx) => {
      const active = await lockActiveCredentialIds(tx, connectionId);
      if (active.length > 0) {
        throw new ActiveCredentialExistsError();
      }
      return this.#insertActive(tx, connectionId, secret);
    });
  }

  /**
   * Atomic rotate: the active row is locked, superseded, and replaced inside a
   * single transaction, so a failure anywhere leaves the old credential usable.
   */
  async replaceCredential(
    connectionId: string,
    newPat: string,
  ): Promise<StoredCredentialRef> {
    // Rejected before the transaction, so the existing credential stays active.
    const secret = assertValidPat(newPat);

    return this.#prisma.$transaction(async (tx) => {
      const active = await lockActiveCredentialIds(tx, connectionId);
      if (active.length > 0) {
        await tx.userCredential.updateMany({
          where: { id: { in: active }, status: "active" },
          data: { status: "superseded" },
        });
      }
      return this.#insertActive(tx, connectionId, secret);
    });
  }

  /** Decrypts per call; no plaintext is cached beyond the returned string. */
  async getAccessToken(connectionId: string): Promise<string> {
    const row = await this.#prisma.userCredential.findFirst({
      where: { connectionId, status: "active" },
      orderBy: { createdAt: "desc" },
    });
    if (!row) {
      throw new NoActiveCredentialError();
    }

    try {
      return await this.#sealer.open(toSealed(row), {
        connectionId: row.connectionId,
        credentialId: row.id,
      });
    } catch (error) {
      // Crypto errors are typed and secret-free; anything else is collapsed.
      if (isCryptoError(error)) {
        throw error;
      }
      throw new CredentialUnreadableError();
    }
  }

  /**
   * Idempotent: only a currently active credential moves out of `active`.
   * A superseded, revoked, or invalid row is never reactivated or rewritten.
   */
  async invalidateCredential(
    connectionId: string,
    reason: InvalidateReason,
  ): Promise<void> {
    const status = REASON_TO_STATUS[reason];
    if (!status) {
      throw new InvalidInvalidationReasonError();
    }

    await this.#prisma.userCredential.updateMany({
      where: { connectionId, status: "active" },
      data: {
        status,
        invalidationReason: reason,
        revokedAt: new Date(),
      },
    });
  }

  async #insertActive(
    tx: TransactionClient,
    connectionId: string,
    secret: string,
  ): Promise<StoredCredentialRef> {
    // The id is generated first so it can be bound into the AAD before sealing.
    const credentialId = randomUUID();
    const sealed = await this.#sealer.seal(secret, { connectionId, credentialId });

    try {
      await tx.userCredential.create({
        data: {
          id: credentialId,
          connectionId,
          ciphertext: Buffer.from(sealed.ciphertext),
          authTag: Buffer.from(sealed.authTag),
          nonce: Buffer.from(sealed.nonce),
          envelopeVersion: sealed.envelopeVersion,
          keyVersion: sealed.keyVersion,
          patHintLast4: patHintLast4(secret),
          status: "active",
        },
      });
    } catch (error) {
      // The partial unique index is the last line of defence against a
      // concurrent replace; the driver message never leaves this frame.
      if (isUniqueViolation(error)) {
        throw new ConcurrentCredentialReplaceError();
      }
      if (isForeignKeyViolation(error)) {
        throw new ConnectionNotFoundError();
      }
      throw new CredentialStoreFailedError();
    }

    return { credentialId, patHintLast4: patHintLast4(secret) };
  }
}

/**
 * `SELECT … FOR UPDATE` serializes concurrent rotations of the same connection.
 * With no active row there is nothing to lock, so two racing inserts are
 * resolved by the `user_credentials_one_active_per_connection` partial index.
 */
async function lockActiveCredentialIds(
  tx: TransactionClient,
  connectionId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "user_credentials"
    WHERE "connection_id" = ${connectionId}
      AND "status" = 'active'
    FOR UPDATE
  `;
  return rows.map((row) => row.id);
}

export function createPatCredentialProvider(
  deps: PatCredentialProviderDeps,
): PatCredentialProvider {
  return new PrismaPatCredentialProvider(deps);
}
