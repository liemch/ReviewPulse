import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SealedSecret, SecretSealer } from "@reviewpulse/crypto";
import type { PrismaClient } from "@reviewpulse/db";

import { PrismaPatCredentialProvider } from "./pat-credential-provider.js";

const VALID_PAT = "glpat-EXAMPLE-not-a-real-token-9876";

const REJECTED_PATS = [
  "",
  "   ",
  ` ${VALID_PAT}`,
  `${VALID_PAT} `,
  `${VALID_PAT}\n`,
  `${VALID_PAT}\t`,
  `${VALID_PAT}\r`,
];

/**
 * Every method throws, so any database access at all is visible: a rejected PAT
 * must never get far enough to open a transaction.
 */
function trackingPrisma(): { prisma: PrismaClient; calls: string[] } {
  const calls: string[] = [];
  const trap =
    (name: string) =>
    (..._args: unknown[]): never => {
      calls.push(name);
      throw new Error(`database was reached: ${name}`);
    };

  const prisma = {
    $transaction: trap("$transaction"),
    $queryRaw: trap("$queryRaw"),
    userCredential: {
      create: trap("userCredential.create"),
      findFirst: trap("userCredential.findFirst"),
      findMany: trap("userCredential.findMany"),
      updateMany: trap("userCredential.updateMany"),
      count: trap("userCredential.count"),
    },
  } as unknown as PrismaClient;

  return { prisma, calls };
}

function trackingSealer(): { sealer: SecretSealer; sealed: string[] } {
  const sealed: string[] = [];
  const sealer: SecretSealer = {
    seal: async (plaintext: string): Promise<SealedSecret> => {
      sealed.push(plaintext);
      throw new Error("seal should not run in these tests");
    },
    open: async (): Promise<string> => {
      throw new Error("open should not run in these tests");
    },
  };
  return { sealer, sealed };
}

describe("PatCredentialProvider PAT validation", () => {
  it("rejects a malformed PAT in storeCredential before any database work", async () => {
    for (const pat of REJECTED_PATS) {
      const { prisma, calls } = trackingPrisma();
      const { sealer, sealed } = trackingSealer();
      const provider = new PrismaPatCredentialProvider({ prisma, sealer });

      await assert.rejects(() => provider.storeCredential("conn_1", pat), {
        code: "INVALID_PAT",
      });
      assert.deepEqual(calls, [], "no credential row may be created");
      assert.deepEqual(sealed, [], "rejected input must not reach the sealer");
    }
  });

  it("rejects a malformed PAT in replaceCredential before any database work", async () => {
    for (const pat of REJECTED_PATS) {
      const { prisma, calls } = trackingPrisma();
      const { sealer, sealed } = trackingSealer();
      const provider = new PrismaPatCredentialProvider({ prisma, sealer });

      await assert.rejects(() => provider.replaceCredential("conn_1", pat), {
        code: "INVALID_PAT",
      });
      assert.deepEqual(
        calls,
        [],
        "the existing credential must not be touched",
      );
      assert.deepEqual(sealed, []);
    }
  });

  it("keeps the rejected PAT out of the error payload", async () => {
    const { prisma } = trackingPrisma();
    const { sealer } = trackingSealer();
    const provider = new PrismaPatCredentialProvider({ prisma, sealer });

    try {
      await provider.storeCredential("conn_1", `${VALID_PAT}\n`);
      assert.fail("expected INVALID_PAT");
    } catch (error) {
      const serialized = `${String(error)}${JSON.stringify(error)}${
        (error as Error).stack ?? ""
      }`;
      assert.ok(!serialized.includes(VALID_PAT));
      assert.ok(!serialized.includes("9876"));
    }
  });

  it("does reach the database for a valid PAT", async () => {
    const { prisma, calls } = trackingPrisma();
    const { sealer } = trackingSealer();
    const provider = new PrismaPatCredentialProvider({ prisma, sealer });

    await assert.rejects(() => provider.storeCredential("conn_1", VALID_PAT), {
      message: "database was reached: $transaction",
    });
    assert.deepEqual(calls, ["$transaction"]);
  });
});
