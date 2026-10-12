import { cleanupE2eUsers } from "../packages/db/test/cleanup-e2e-users";

/**
 * După testele E2E: șterge utilizatorii creați de teste. Convenția: orice cont creat de un test
 * E2E are emailul `e2e-<id>@example.test`. Rulează doar pe baza de test (gardă în funcție).
 */
export default async function globalTeardown(): Promise<void> {
  const removed = await cleanupE2eUsers(process.env["TEST_DATABASE_URL"]);
  if (removed > 0) console.log(`[e2e] șterși ${removed} utilizatori de test`);
}
