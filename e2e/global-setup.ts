import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { clearE2eRateLimits } from "../packages/core/test/e2e-support";
import { cleanupE2eUsers, setTestSetting } from "../packages/db/test/cleanup-e2e-users";
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

  // Rulările E2E oprite din afară nu apucă `global-teardown`: conturile `e2e-*` rămase sunt curățate
  // la începutul rulării, nu doar la final (garda „test” e în funcție).
  const leftover = await cleanupE2eUsers(process.env["TEST_DATABASE_URL"]);
  if (leftover > 0)
    console.log(`[e2e] șterse ${leftover} conturi e2e-* rămase din rulări anterioare`);

  // Un proxy de încredere: Next adaugă singur `X-Forwarded-For` (IP-ul socketului) când lipsește, iar
  // testele trimit propriul antet ca să aibă IP-uri distincte (limitele pe IP nu se amestecă).
  await setTestSetting(process.env["TEST_DATABASE_URL"], "auth.trustedProxyHops", 1);
  // Toate cererile din browser vin de la același IP (localhost): limita de înregistrări pe IP nu are
  // sens într-o suită care creează zeci de conturi. Se testează separat, în teste unitare.
  await setTestSetting(process.env["TEST_DATABASE_URL"], "auth.registerMaxAttempts", 100);
  // Contoarele de limitare ale unei rulări anterioare nu trebuie să le afecteze pe cele ale acesteia.
  await clearE2eRateLimits();

  // Scripturile citesc DATABASE_URL și REDIS_URL din mediu, deci primesc explicit bazele de TEST
  // (niciodată cele din .env).
  const testEnv = {
    ...process.env,
    DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "",
    REDIS_URL: process.env["TEST_REDIS_URL"] ?? "",
  };
  // Seed-ul de pachet (roluri, permisiuni, setări implicite, flag-uri oprite): idempotent.
  execSync("node --import tsx packages/core/scripts/seed.ts", {
    cwd: process.cwd(),
    env: testEnv,
    stdio: "pipe",
  });
  // Trimiterea emailurilor spre Mailpit (SMTP localhost:1025), ca testele cu email să ajungă la el.
  execSync("node --import tsx packages/core/scripts/dev-mail.ts", {
    cwd: process.cwd(),
    env: testEnv,
    stdio: "pipe",
  });
}
