/** Argon2id password hashing. Never log plaintext or the hash. */

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

import { InvalidInputError } from "./errors.js";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

/** OWASP-ish Argon2id defaults for interactive login. Algorithm 2 = Argon2id. */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  algorithm: 2,
};

export function assertPasswordPolicy(password: string): void {
  if (typeof password !== "string") {
    throw new InvalidInputError({ reason: "password_not_string" });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new InvalidInputError({ reason: "password_too_short" });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new InvalidInputError({ reason: "password_too_long" });
  }
  // Reject passwords that are only whitespace or that differ when trimmed —
  // same spirit as the WP1 PAT whitespace policy.
  if (password !== password.trim() || password.trim().length === 0) {
    throw new InvalidInputError({ reason: "password_whitespace" });
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return await argonHash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  passwordHashArgon2id: string,
  password: string,
): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) {
    return false;
  }
  if (
    typeof passwordHashArgon2id !== "string" ||
    passwordHashArgon2id.length === 0
  ) {
    return false;
  }
  try {
    return await argonVerify(passwordHashArgon2id, password);
  } catch {
    return false;
  }
}
