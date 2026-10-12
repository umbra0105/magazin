import { fileURLToPath } from "node:url";
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
}
