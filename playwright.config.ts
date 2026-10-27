import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  assertTestBucket,
  assertTestDatabase,
  assertTestRedis,
  deriveE2eRedisUrl,
  deriveTestBucket,
  deriveTestDatabaseUrl,
  deriveTestRedisUrl,
} from "./test/support/test-env";

const port = 3100;
// Al doilea server E2E, cu driverul S3 (MinIO), pentru `e2e/media-s3.spec.ts` (proiectul `chromium-s3`).
const s3Port = 3101;
// `E2E_TARGET=s3` (scriptul `test:e2e:s3`): rulează DOAR specul S3, cu DOAR serverul S3 pornit. Un singur
// server de test o dată (RAM), iar suita obișnuită nu depinde de MinIO.
const s3Only = process.env["E2E_TARGET"] === "s3";

// Fișierele încărcate de testele E2E stau într-un director temporar (șters de global-teardown), nu în
// bucketul de dezvoltare. Testul pe S3 are serverul și bucketul lui (vezi `s3Server` mai jos).
export const e2eStorageDir = join(tmpdir(), "ecom-e2e-storage");
process.env["E2E_STORAGE_DIR"] = e2eStorageDir;

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
// Indexul Redis al E2E e separat de cel al testelor de integrare (vezi `deriveE2eRedisUrl`).
// Playwright reevaluează această configurație în fiecare worker, când `TEST_REDIS_URL` e deja indexul E2E: indexul se
// păstrează în `E2E_REDIS_URL` și se refolosește, ca derivarea să nu se aplice a doua oară.
const e2eRedisUrl = process.env["E2E_REDIS_URL"] ?? deriveE2eRedisUrl(testRedisUrl);
assertTestRedis(e2eRedisUrl);
process.env["E2E_REDIS_URL"] = e2eRedisUrl;
process.env["TEST_REDIS_URL"] = e2eRedisUrl;

// Serverul S3: bucket de test (garda „test” în nume) creat de `storage:init` la pornire și Redis pe
// ALT index (2), ca joburile `media` ale lui să nu fie preluate de workerul serverului cu storage
// local (și invers). Baza de date e aceeași (de test).
const s3Bucket = deriveTestBucket(
  process.env["S3_BUCKET"] ?? "ecom",
  process.env["TEST_S3_BUCKET"],
);
assertTestBucket(s3Bucket);
const s3RedisUrl = testRedisUrl.replace(/\/\d+$/, "/2");
assertTestRedis(s3RedisUrl);
const s3Endpoint = (process.env["S3_ENDPOINT"] ?? "http://localhost:9000").replace(/\/+$/, "");

const localServer = {
  // Mod producție (`next build` + `next start` + worker separat), la fel local și în CI: memorie
  // stabilă, fără compilare la cerere (vezi scripts/e2e-server.mjs).
  command: `node scripts/e2e-server.mjs ${port}`,
  url: `http://localhost:${port}`,
  // Niciodată un server deja pornit: ar putea fi unul legat de baza de dezvoltare.
  reuseExistingServer: false,
  // Include build-ul de producție.
  timeout: 420_000,
  // E2E_SERVER_LOGS=1: stdout-ul serverului și al workerului (durata build-ului, joburi) în rezultat.
  stdout: process.env["E2E_SERVER_LOGS"] === "1" ? ("pipe" as const) : ("ignore" as const),
  env: {
    // Mediul serverului de test: baza și Redis-ul de test, nu cele din .env.
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: e2eRedisUrl,
    // Better Auth acceptă doar originea din APP_URL: serverul de test trebuie să o știe pe a lui.
    APP_URL: `http://localhost:${port}`,
    // Director de build propriu: serverul E2E nu scrie peste `.next` al unui server de dev pornit.
    NEXT_DIST_DIR: ".next-e2e",
    // Activează harness-urile `*.e2e.tsx` (vezi next.config.ts); niciodată în producție.
    E2E_HARNESS: "1",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_PATH: e2eStorageDir,
  },
};

const s3Server = {
  // Întâi bucketul de test (`storage:init`, idempotent), apoi serverul cu driverul S3.
  command: `node --import tsx packages/core/scripts/storage-init.ts && node scripts/e2e-server.mjs ${s3Port}`,
  url: `http://localhost:${s3Port}`,
  reuseExistingServer: false,
  timeout: 420_000,
  env: {
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: s3RedisUrl,
    APP_URL: `http://localhost:${s3Port}`,
    NEXT_DIST_DIR: ".next-e2e-s3",
    E2E_HARNESS: "1",
    STORAGE_DRIVER: "s3",
    S3_BUCKET: s3Bucket,
    S3_PUBLIC_URL: `${s3Endpoint}/${s3Bucket}`,
  },
};

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  // Un singur server servește toți lucrătorii; pe `next dev` (înainte de modul producție), cu 6 (implicit
  // pe 12 nuclee) compilarea la rece și cererile concurente depășeau timeout-urile. Local rămân 2
  // (decizie utilizator); în CI (Linux) rămâne valoarea implicită.
  workers: process.env.CI ? undefined : 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Prima vizită a unei rute în `next dev` o compilează; testele de admin parcurg mai multe rute noi.
  timeout: 90_000,
  // Prima cerere către o rută în `next dev` o compilează (pe Windows cu SWC blocat, încet).
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${port}`, trace: "on-first-retry" },
  projects: s3Only
    ? [
        {
          name: "chromium-s3",
          testMatch: /media-s3.spec.ts/,
          use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${s3Port}` },
        },
      ]
    : [
        {
          name: "chromium",
          testIgnore: /media-s3.spec.ts/,
          use: { ...devices["Desktop Chrome"] },
        },
      ],
  webServer: s3Only ? s3Server : localServer,
});
