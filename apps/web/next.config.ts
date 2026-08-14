import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PHI responses must never be cached client-side (docs/09 §4).
  async headers() {
    return [
      {
        source: "/(office|clinical|exec|today|family|welcome)/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
