/**
 * Bootstrap the first admin user. CLI only — never exposed as an HTTP route.
 *
 * Usage:
 *   BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
 *   BOOTSTRAP_ADMIN_PASSWORD_FILE=/secure/path/password.txt \
 *   npm run auth:bootstrap-admin
 *
 * Or:
 *   npm run auth:bootstrap-admin -- --email admin@example.com --password-file ./pw.txt
 *
 * The password is never written to logs or the audit meta.
 */

import { readFileSync } from "node:fs";

import {
  AuditWriter,
  hashPassword,
  loadSessionPolicy,
  normalizeEmail,
  SessionService,
} from "@reviewpulse/app-auth";
import { prisma } from "@reviewpulse/db";
import { loadMonorepoEnv } from "@reviewpulse/db/load-env";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  loadMonorepoEnv();
  // Touch session policy so SESSION_SECRET is validated early.
  loadSessionPolicy(process.env);

  const email =
    argValue("--email") ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? "";
  const passwordFile =
    argValue("--password-file") ??
    process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE ??
    "";

  if (!email || !passwordFile) {
    console.error(
      "Usage: auth:bootstrap-admin --email <email> --password-file <path>",
    );
    process.exit(2);
  }

  const password = readFileSync(passwordFile, "utf8").replace(/\n$/, "");
  const normalized = normalizeEmail(email);
  const existing = await prisma.user.findUnique({
    where: { normalizedEmail: normalized },
  });
  if (existing) {
    console.error("Admin user already exists for that email.");
    process.exit(1);
  }

  const passwordHashArgon2id = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email: email.trim(),
      normalizedEmail: normalized,
      passwordHashArgon2id,
      role: "admin",
      status: "active",
    },
  });

  const audit = new AuditWriter(prisma);
  await audit.write("user_created", user.id, {
    bootstrap: true,
    role: "admin",
  });

  // Ensure SessionService is constructible with current env (sanity).
  new SessionService(prisma, loadSessionPolicy(process.env), audit);

  console.log(`Bootstrap admin created: ${user.email} (${user.id})`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "bootstrap failed";
    console.error(message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
