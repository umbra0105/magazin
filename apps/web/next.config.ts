import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { legacyAdminRedirects } from "./src/lib/admin-redirects";

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
  // Harness-urile pentru teste (`*.e2e.tsx`) devin rute doar cu E2E_HARNESS=1 (setat de Playwright);
  // într-un build normal fișierele nu sunt nici rute, nici compilate.
  pageExtensions:
    process.env["E2E_HARNESS"] === "1"
      ? ["tsx", "ts", "jsx", "js", "e2e.tsx"]
      : ["tsx", "ts", "jsx", "js"],
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
  // Ecranele mutate sub «Produse» (blocul 8b): adresele vechi redirecționează permanent (308), cu parametrii păstrați.
  async redirects() {
    return legacyAdminRedirects();
  },
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
  experimental: {
    // Cu middleware, Next păstrează în memorie corpul cererii și îl TRUNCHIAZĂ la limită în tăcere, ÎNAINTE de orice
    // verificare. Rutele de încărcare (până la 50 MB) sunt scoase din middleware (`matcher`), iar restul au nevoie
    // doar de JSON și formulare mici: limita rămâne mică, ca niciun anonim să nu poată hrăni o rută cu corpuri mari.
    middlewareClientMaxBodySize: "2mb",
  },
  serverExternalPackages: ["pg", "ioredis", "pino", "bullmq", "nodemailer", "sharp"],
};

// Fără org/project/authToken: nu urcă source maps și nu contactează Sentry la build.
// DSN-ul vine la runtime din Setting, nu din config.
export default withSentryConfig(nextConfig, {
  silent: !process.env["CI"],
  telemetry: false,
});
