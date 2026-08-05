/**
 * Test-only ephemeral TLS material.
 *
 * Generates a fresh CA + server keypair in a temp directory for each call.
 * Nothing here is committed, logged, or imported by production code.
 *
 * Requires OpenSSL on PATH. CI must have it (GitHub ubuntu runners do);
 * local runs without OpenSSL report a clear skip rather than a false pass.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WP2_TEST_HOSTNAME = "gitlab.wp2.test" as const;
export const WP2_TEST_PINNED_IP = "127.0.0.1" as const;

export type EphemeralTlsMaterial = {
  readonly hostname: typeof WP2_TEST_HOSTNAME;
  readonly pinnedIp: typeof WP2_TEST_PINNED_IP;
  readonly dir: string;
  readonly caCertPath: string;
  readonly caCertPem: string;
  readonly serverCertPem: string;
  readonly serverKeyPem: string;
  cleanup(): Promise<void>;
};

let cachedOpenSsl: string | null | undefined;

/** Absolute path to openssl, or null when unavailable. */
export function findOpenSsl(): string | null {
  if (cachedOpenSsl !== undefined) {
    return cachedOpenSsl;
  }
  try {
    const which = execFileSync("sh", ["-c", "command -v openssl"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    cachedOpenSsl = which.length > 0 ? which : null;
  } catch {
    cachedOpenSsl = null;
  }
  return cachedOpenSsl;
}

export function isCiEnvironment(): boolean {
  const value = process.env["CI"];
  return value === "true" || value === "1";
}

/**
 * OpenSSL is mandatory on CI. Locally its absence is a documented NOT RUN,
 * not a silent skip of a security check that CI already gates.
 */
export function requireOpenSslOrExplain(): string | { notRun: string } {
  const bin = findOpenSsl();
  if (bin !== null) {
    return bin;
  }
  if (isCiEnvironment()) {
    throw new Error(
      "OpenSSL is required for WP2 TLS smoke tests in CI (GitHub ubuntu runners include it)",
    );
  }
  return {
    notRun:
      "OpenSSL not found on PATH — TLS smoke NOT RUN locally; CI must still PASS",
  };
}

export async function createEphemeralTlsMaterial(): Promise<EphemeralTlsMaterial> {
  const openssl = findOpenSsl();
  if (openssl === null) {
    throw new Error("createEphemeralTlsMaterial requires OpenSSL");
  }

  const dir = await mkdtemp(join(tmpdir(), "reviewpulse-wp2-tls-"));
  const caKey = join(dir, "ca.key");
  const caCert = join(dir, "ca.pem");
  const serverKey = join(dir, "server.key");
  const serverCsr = join(dir, "server.csr");
  const serverCert = join(dir, "server.pem");
  const serverExt = join(dir, "server.ext");

  const run = (args: string[]): void => {
    execFileSync(openssl, args, {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
  };

  try {
    run([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-subj",
      "/CN=ReviewPulse WP2 Test CA",
    ]);
    run([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKey,
      "-out",
      serverCsr,
      "-subj",
      `/CN=${WP2_TEST_HOSTNAME}`,
    ]);
    await writeFile(
      serverExt,
      `subjectAltName=DNS:${WP2_TEST_HOSTNAME},IP:${WP2_TEST_PINNED_IP}\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    run([
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverCert,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      serverExt,
    ]);

    const [caCertPem, serverCertPem, serverKeyPem] = await Promise.all([
      readFile(caCert, "utf8"),
      readFile(serverCert, "utf8"),
      readFile(serverKey, "utf8"),
    ]);

    return {
      hostname: WP2_TEST_HOSTNAME,
      pinnedIp: WP2_TEST_PINNED_IP,
      dir,
      caCertPath: caCert,
      caCertPem,
      serverCertPem,
      serverKeyPem,
      async cleanup() {
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
