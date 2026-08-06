import type { NextConfig } from "next";

// Root `.env` is loaded by `scripts/preload-env.mjs` (see package.json scripts).
// Do not import dotenv here — it breaks the Next webpack production build.

const nextConfig: NextConfig = {
  transpilePackages: [
    "@reviewpulse/db",
    "@reviewpulse/app-auth",
    "@reviewpulse/crypto",
    "@reviewpulse/credentials",
    "@reviewpulse/gitlab-client",
    "@reviewpulse/domain",
  ],
  // Next 16 defaults to Turbopack. WP0 keeps webpack for NodeNext `.js`→`.ts`
  // resolution across workspace packages (`npm run build` / `dev` pass `--webpack`).
  turbopack: {},
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
