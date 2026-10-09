/**
 * Seed-ul de pachet: `pnpm db:seed`. Idempotent; vezi `runBaseSeed`.
 * Nu creează utilizatori și nu conține parole.
 */
import { runBaseSeed } from "../src/seed/base-seed";
import { getDb, invalidateConfigCaches, loadRootEnv } from "./_runtime";

loadRootEnv();
const db = getDb();

try {
  const result = await db.$transaction((tx) => runBaseSeed(tx));
  const cacheCleared = await invalidateConfigCaches();
  console.log("Seed de bază aplicat (valorile noi adăugate; cele existente rămân neschimbate):");
  console.log(`  permisiuni noi:        ${result.permissions}`);
  console.log(`  roluri noi:            ${result.roles}`);
  console.log(`  legături rol-permisiune noi: ${result.rolePermissions}`);
  console.log(`  setări noi:            ${result.settings}`);
  console.log(`  flag-uri noi (oprite): ${result.featureFlags}`);
  console.log(`  branding implicit:     ${result.brandingCreated ? "creat" : "există deja"}`);
  console.log(
    `  cache Redis:           ${cacheCleared ? "golit" : "indisponibil (expiră singur)"}`,
  );
} finally {
  await db.$disconnect();
}
