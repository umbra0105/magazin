import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Prima cerere către o rută în `next dev` o compilează (pe Windows cu SWC blocat, încet).
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${port}`, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @ecom/web exec next dev --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    // Better Auth acceptă doar originea din APP_URL: serverul de test trebuie să o știe pe a lui.
    env: { APP_URL: `http://localhost:${port}` },
    timeout: 120_000,
  },
});
