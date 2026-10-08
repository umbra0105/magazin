import type { NextConfig } from "next";

// Next citește .env doar din folderul aplicației; .env-ul proiectului e în rădăcina repo-ului.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // Fără .env în rădăcină (ex. în Docker, variabilele vin din mediu): loadEnv() validează la boot.
}

const nextConfig: NextConfig = {
  // `standalone` se activează doar în build-ul Docker (Faza 23); pe Windows
  // generarea lui eșuează fără drepturi de symlink.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  reactStrictMode: true,
  // Pachetele workspace sunt livrate ca TypeScript sursă.
  transpilePackages: ["@ecom/shared", "@ecom/config", "@ecom/core"],
  serverExternalPackages: ["pg", "ioredis", "pino"],
};

export default nextConfig;
