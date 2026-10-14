import { fileURLToPath } from "node:url";
import { cleanupE2eUsers } from "./cleanup-e2e-users";
import { prepareTestDatabase } from "./prepare-test-database";

/**
 * Înaintea testelor de integrare (Vitest): pregătește baza de test. TEST_DATABASE_URL și
 * TEST_REDIS_URL sunt setate de vitest.config.mts (derivate din mediul de dezvoltare sau explicite).
 * Rulează o singură dată per `vitest run`, în procesul principal.
 */
export default async function setup(): Promise<void> {
  await prepareTestDatabase(
    process.env["TEST_DATABASE_URL"],
    process.env["TEST_REDIS_URL"],
    fileURLToPath(new URL("..", import.meta.url)),
  );
  // Conturile `e2e-*` rămase după o rulare E2E oprită din afară (global-teardown nu a apucat să
  // ruleze) strică testele care numără utilizatori/roluri (ex. rbac/revoke). Garda „test” e în funcție.
  const removed = await cleanupE2eUsers(process.env["TEST_DATABASE_URL"]);
  if (removed > 0)
    console.log(`[teste] șterse ${removed} conturi e2e-* rămase din rulări anterioare`);
}
