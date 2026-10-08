import { defineConfig } from "vitest/config";

// Variabilele din .env (dacă există) pentru testele de integrare rulate local; în CI vin din mediu.
try {
  process.loadEnvFile(new URL("./.env", import.meta.url));
} catch {
  // fără .env: se folosește mediul curent
}

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
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
        },
      },
    ],
  },
});
