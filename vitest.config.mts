import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { integrationEnv } from "./test/support/test-env";

// Variabilele din .env (dacă există) pentru testele de integrare rulate local; în CI vin din mediu.
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // fără .env: se folosește mediul curent
}

// Testele de integrare rulează pe o bază Postgres și un DB Redis SEPARATE de cele de dezvoltare
// (vezi test/support/test-env.ts). globalSetup (procesul principal) citește TEST_*, iar workerii
// primesc DATABASE_URL/REDIS_URL deja îndreptate spre bazele de test.
const testEnv = integrationEnv();
if (testEnv.DATABASE_URL) process.env["TEST_DATABASE_URL"] = testEnv.DATABASE_URL;
if (testEnv.REDIS_URL) process.env["TEST_REDIS_URL"] = testEnv.REDIS_URL;

export default defineConfig({
  // Aliasul `@/` din apps/web (tsconfig paths), ca testele să poată importa rutele aplicației.
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
          testTimeout: 15_000,
          // Un singur DB de test partajat: fișierele rulează pe rând, ca testele care golesc/numără
          // aceleași tabele (setting, feature_flag, branding...) să nu se calce între ele.
          fileParallelism: false,
          env: testEnv,
          globalSetup: ["./packages/db/test/global-setup.ts"],
          setupFiles: ["./test/support/integration-guard.ts"],
        },
      },
    ],
  },
});
