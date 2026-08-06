/** Safe audit event writer — never accepts raw secrets as meta. */

import type { Prisma, PrismaClient } from "@reviewpulse/db";
import { redact } from "@reviewpulse/crypto";

export type AuditAction =
  | "user_created"
  | "user_invited"
  | "user_deactivated"
  | "role_changed"
  | "password_reset_by_admin"
  | "login_success"
  | "login_failure"
  | "logout"
  | "sessions_revoked"
  | "gitlab_connection_created"
  | "gitlab_connection_tested"
  | "gitlab_connection_replaced"
  | "gitlab_connection_deleted"
  | "gitlab_connection_invalid"
  | "project_enabled"
  | "project_disabled"
  | "allowlist_instance_added"
  | "allowlist_instance_removed"
  | "allowlist_project_added"
  | "allowlist_project_removed";

const FORBIDDEN_META_KEYS = new Set([
  "password",
  "pat",
  "token",
  "session",
  "ciphertext",
  "nonce",
  "secret",
  "authorization",
  "private-token",
  "privatetoken",
  "accesstoken",
]);

export class AuditWriter {
  constructor(private readonly prisma: PrismaClient) {}

  async write(
    action: AuditAction,
    actorUserId: string | null,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    for (const key of Object.keys(meta)) {
      if (FORBIDDEN_META_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""))) {
        throw new Error("audit meta must not include secrets");
      }
    }
    const safe = (redact(meta) ?? {}) as Prisma.InputJsonValue;
    await this.prisma.auditEvent.create({
      data: {
        action,
        actorUserId,
        metaJsonSafe: safe,
      },
    });
  }
}
