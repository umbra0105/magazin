import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` se activează doar în build-ul Docker (Faza 23); pe Windows
  // generarea lui eșuează fără drepturi de symlink.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  reactStrictMode: true,
};

export default nextConfig;
