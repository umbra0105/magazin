/**
 * Seed SPECIFIC MAGAZINULUI: `pnpm db:seed:store`. Îl rulează doar proprietarul acestei instalări.
 * NU face parte din pachetul distribuit (la împachetare, Faza 21, se mută în instalarea lui sau în
 * `/extensions`). Idempotent. Rulează după `pnpm db:seed`.
 *
 * Ce intră aici: tot ce e doar al acestui magazin și nu un default de pachet.
 *
 * Grupurile de clienți ale magazinului (Faza 15): Client fidel 5% și Client VIP 7% (`discount`), Partener 1/2/3 cu
 * adaos 12% / 17% / 21% (`cost_plus`, `earnsLoyaltyPoints = false`). «Client standard» e grupul de sistem, din seed-ul de
 * bază (`db:seed`). Procentele se editează din admin; rularea repetată nu le suprascrie.
 */
import { createPrismaFeatureFlagStore } from "../src/features/prisma-store";
import { FeatureFlagService } from "../src/features/feature-flag-service";
import { seedStoreGroups, STORE_GROUPS } from "../src/customers/store-groups";
import type { FeatureKey } from "../src/features/registry";
import { getDb, invalidateConfigCaches, loadRootEnv } from "./_runtime";

/** Funcționalitățile opționale pornite în ACEST magazin. De completat de proprietar. */
const STORE_FEATURES: readonly FeatureKey[] = [];

loadRootEnv();
const db = getDb();

try {
  // Un cache nul: seed-ul scrie direct în DB, iar la final se golește Redis.
  const noCache = {
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
  };
  const flags = new FeatureFlagService(createPrismaFeatureFlagStore(db), noCache);
  for (const key of STORE_FEATURES) await flags.setEnabled(key, true);

  const groupsCreated = await seedStoreGroups(db);

  const cacheCleared = await invalidateConfigCaches();
  console.log("Seed specific magazinului aplicat:");
  console.log(
    STORE_FEATURES.length > 0
      ? `  funcționalități pornite: ${STORE_FEATURES.join(", ")}`
      : "  funcționalități pornite: niciuna (completează STORE_FEATURES în seed-store.ts)",
  );
  console.log(
    `  grupuri de clienți:      ${groupsCreated} create, ${STORE_GROUPS.length - groupsCreated} existau deja`,
  );
  console.log(
    `  cache Redis:             ${cacheCleared ? "golit" : "indisponibil (expiră singur)"}`,
  );
} finally {
  await db.$disconnect();
}
