import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

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
  // Directorul de build. Implicit `.next`; pentru probe (build/start în paralel cu un server de dev
  // pornit) se setează NEXT_DIST_DIR=.next-probe ca să nu scrie peste `.next` (vezi CLAUDE.md).
  distDir: process.env["NEXT_DIST_DIR"] || ".next",
  // Pachetele workspace sunt livrate ca TypeScript sursă.
  transpilePackages: [
    "@ecom/shared",
    "@ecom/config",
    "@ecom/core",
    "@ecom/db",
    "@ecom/integrations",
    "@ecom/ui",
    "@ecom/jobs",
    "@ecom/emails",
  ],
  // Zona de admin: niciodată în cache partajat sau de browser și niciodată indexată.
  async headers() {
    const privateNoIndex = [
      { key: "Cache-Control", value: "no-store, max-age=0" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
    ];
    return [
      { source: "/admin", headers: privateNoIndex },
      { source: "/admin/:path*", headers: privateNoIndex },
      { source: "/api/admin/:path*", headers: privateNoIndex },
    ];
  },
  serverExternalPackages: [
    "pg",
    "ioredis",
    "pino",
    "@node-rs/argon2",
    "bullmq",
    "nodemailer",
    "sharp",
  ],
};

// Fără org/project/authToken: nu urcă source maps și nu contactează Sentry la build.
// DSN-ul vine la runtime din Setting, nu din config.
export default withSentryConfig(nextConfig, {
  silent: !process.env["CI"],
  telemetry: false,
});
