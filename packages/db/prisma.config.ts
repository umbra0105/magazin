import { loadEnvFile } from "node:process";
import { defineConfig } from "prisma/config";

// .env din rădăcina monorepo-ului (Prisma CLI rulează din packages/db)
try {
  loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // fără .env (ex. CI): DATABASE_URL vine din mediu
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Logica seed-ului stă în @ecom/core (are registrul de setări, flag-uri și presets).
    seed: "tsx ../core/scripts/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
