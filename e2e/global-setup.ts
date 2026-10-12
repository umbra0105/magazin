import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { prepareTestDatabase } from "../packages/db/test/prepare-test-database";

/**
 * Înaintea testelor E2E: creează baza de test dacă lipsește și îi aplică migrațiile (aceeași
 * procedură ca la testele de integrare, cu aceeași gardă: refuză baza și Redis-ul de dezvoltare).
 * Rulează din rădăcina proiectului (`pnpm test:e2e`).
 */
export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase(
    process.env["TEST_DATABASE_URL"],
    process.env["TEST_REDIS_URL"],
    resolve(process.cwd(), "packages", "db"),
  );
  // Seed-ul de pachet (roluri, permisiuni, setări implicite, flag-uri oprite) pe baza de TEST,
  // ca testele de admin să aibă rolurile de sistem. Idempotent; scriptul citește DATABASE_URL și
  // REDIS_URL din mediu, deci primește explicit bazele de test (niciodată cele din .env).
  execSync("node --import tsx packages/core/scripts/seed.ts", {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "",
      REDIS_URL: process.env["TEST_REDIS_URL"] ?? "",
    },
    stdio: "pipe",
  });
}
