import { defineConfig, devices } from "@playwright/test";
import {
  assertTestDatabase,
  assertTestRedis,
  deriveTestDatabaseUrl,
  deriveTestRedisUrl,
} from "./test/support/test-env";

const port = 3100;

// .env din rădăcină (DATABASE_URL / REDIS_URL de dezvoltare) servește DOAR la derivarea numelor
// bazelor de test; serverul E2E nu primește niciodată baza de dezvoltare.
try {
  process.loadEnvFile(".env");
} catch {
  // fără .env: se folosesc variabilele din mediu (CI)
}

// Aceeași regulă ca la testele de integrare: `<bază>_test` și Redis pe alt index decât 0.
const testDatabaseUrl = deriveTestDatabaseUrl(
  process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? "",
  process.env["TEST_DATABASE_URL"],
);
const testRedisUrl = deriveTestRedisUrl(
  process.env["REDIS_URL"] ?? process.env["TEST_REDIS_URL"] ?? "",
  process.env["TEST_REDIS_URL"],
);
// Refuză să pornească dacă ar ajunge pe baza sau pe Redis-ul de dezvoltare.
assertTestDatabase(testDatabaseUrl);
assertTestRedis(testRedisUrl);
// Văzute de global-setup / global-teardown (procesul principal Playwright).
process.env["TEST_DATABASE_URL"] = testDatabaseUrl;
process.env["TEST_REDIS_URL"] = testRedisUrl;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Prima vizită a unei rute în `next dev` o compilează; testele de admin parcurg mai multe rute noi.
  timeout: 90_000,
  // Prima cerere către o rută în `next dev` o compilează (pe Windows cu SWC blocat, încet).
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${port}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node scripts/in.mjs apps/web node_modules/next/dist/bin/next dev --port ${port}`,
    url: `http://localhost:${port}`,
    // Niciodată un server deja pornit: ar putea fi unul legat de baza de dezvoltare.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // Mediul serverului de test: baza și Redis-ul de test, nu cele din .env.
      DATABASE_URL: testDatabaseUrl,
      REDIS_URL: testRedisUrl,
      // Better Auth acceptă doar originea din APP_URL: serverul de test trebuie să o știe pe a lui.
      APP_URL: `http://localhost:${port}`,
    },
  },
});
