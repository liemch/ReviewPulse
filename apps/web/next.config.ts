import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@reviewpulse/db"],
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
