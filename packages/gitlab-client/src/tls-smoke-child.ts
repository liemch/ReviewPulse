/**
 * Child entry for the production-path TLS smoke.
 *
 * Spawned with `NODE_EXTRA_CA_CERTS` pointing at an ephemeral test CA so the
 * production `createPinnedNodeTransport()` (no hooks, system trust + extra CA)
 * can verify the throwaway leaf. Never imports private keys.
 *
 * Env:
 *   WP2_TLS_SMOKE_URL   — https://gitlab.wp2.test:<port>/api/v4/user
 *   WP2_TLS_SMOKE_PIN   — 127.0.0.1
 *   WP2_TLS_SMOKE_TOKEN — PAT placed only in PRIVATE-TOKEN
 */

import { createPinnedNodeTransport } from "./transport.js";
import { PRIVATE_TOKEN_HEADER } from "./auth.js";

async function main(): Promise<void> {
  const url = process.env["WP2_TLS_SMOKE_URL"];
  const pin = process.env["WP2_TLS_SMOKE_PIN"];
  const token = process.env["WP2_TLS_SMOKE_TOKEN"];
  if (!url || !pin || !token) {
    console.error("missing WP2_TLS_SMOKE_* env");
    process.exit(2);
  }

  const transport = createPinnedNodeTransport();
  const response = await transport.send({
    url,
    headers: {
      [PRIVATE_TOKEN_HEADER]: token,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(5_000),
    pin: { address: pin, family: 4 },
  });

  if (response.status !== 200) {
    console.error(`unexpected status ${response.status}`);
    process.exit(1);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
  if (!body.includes("tls-smoke")) {
    console.error("missing tls-smoke marker in body");
    process.exit(1);
  }
  if (body.includes(token) || body.includes("BEGIN ")) {
    console.error("body leaked a secret");
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  // Never print the token even if somehow present in the error text.
  const token = process.env["WP2_TLS_SMOKE_TOKEN"] ?? "";
  console.error(token.length > 0 ? message.split(token).join("[REDACTED]") : message);
  process.exit(1);
});
