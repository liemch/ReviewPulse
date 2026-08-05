/** WP0 interface stub — AES-256-GCM + key_version lands in WP1. */

export type SealedSecret = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
};

export interface SecretSealer {
  seal(plaintext: Uint8Array): Promise<SealedSecret>;
  open(sealed: SealedSecret): Promise<Uint8Array>;
}

export const PACKAGE_NAME = "@reviewpulse/crypto" as const;
