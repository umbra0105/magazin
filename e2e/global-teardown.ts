import { rm } from "node:fs/promises";
import { removeE2eStock } from "../packages/core/test/e2e-support";
import { cleanupE2eUsers } from "../packages/db/test/cleanup-e2e-users";

/**
 * După testele E2E: șterge utilizatorii creați de teste. Convenția: orice cont creat de un test
 * E2E are emailul `e2e-<id>@example.test`. Rulează doar pe baza de test (gardă în funcție).
 */
export default async function globalTeardown(): Promise<void> {
  const removed = await cleanupE2eUsers(process.env["TEST_DATABASE_URL"]);
  if (removed > 0) console.log(`[e2e] șterși ${removed} utilizatori de test`);
  // produsele de stoc de test: fiecare fișier își șterge ale lui (pe tag); aici, la final, orice rest (un fișier întrerupt)
  const stock = await removeE2eStock();
  if (stock > 0) console.log(`[e2e] șterse ${stock} produse de stoc de test rămase`);
  const storage = process.env["E2E_STORAGE_DIR"];
  if (storage && /ecom-e2e-storage$/.test(storage)) {
    await rm(storage, { recursive: true, force: true });
  }
}
