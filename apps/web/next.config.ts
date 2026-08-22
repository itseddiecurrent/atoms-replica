import { config } from "dotenv";
import type { NextConfig } from "next";
import { resolve } from "node:path";

import { productionSecurityHeaders } from "./src/lib/security-headers";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: ["@atom-replica/db", "@atom-replica/shared"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: productionSecurityHeaders(process.env.E2B_PREVIEW_CSP_ORIGIN)
      }
    ];
  }
};

export default nextConfig;
