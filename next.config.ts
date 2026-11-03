import { withBotId } from "botid/next/config";
import type { NextConfig } from "next";
import { checkSsoEnvForBuild } from "./lib/sso/config";

// Fail fast: a Vercel production build stops here (and the live deployment
// stays untouched) if an app SSO variable is set but malformed. Missing URLs
// fall back to their defaults; a missing SSO secret only warns. The error
// names the variable, never its value.
if (process.env.VERCEL_ENV === "production") {
  checkSsoEnvForBuild();
}

const basePath = process.env.IS_DEMO === "1" ? "/demo" : "";

const nextConfig: NextConfig = {
  ...(basePath
    ? {
        assetPrefix: "/demo-assets",
        basePath,
        redirects: async () => [
          {
            basePath: false,
            destination: basePath,
            permanent: false,
            source: "/",
          },
        ],
      }
    : {}),
  cacheComponents: true,
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  experimental: {
    appNewScrollHandler: true,
    cachedNavigations: true,
    inlineCss: true,
    prefetchInlining: true,
    turbopackFileSystemCacheForDev: true,
  },
  images: {
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        hostname: "*.public.blob.vercel-storage.com",
        protocol: "https",
      },
    ],
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: false,
  },
  poweredByHeader: false,
  reactCompiler: true,
};

export default withBotId(nextConfig);
