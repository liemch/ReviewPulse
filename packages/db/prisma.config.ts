import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { defineConfig, env } from "prisma/config";

// Load monorepo root `.env` (WP0 templates live at repo root).
loadEnv({ path: resolve(import.meta.dirname, "../../.env"), quiet: true });
loadEnv({ path: resolve(import.meta.dirname, "../../.env.example"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
