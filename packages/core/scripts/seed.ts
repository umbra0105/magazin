/**
 * Seed-ul de pachet: `pnpm db:seed`. Idempotent; vezi `runBaseSeed`.
 * Nu creează utilizatori și nu conține parole.
 */
import { readFileSync } from "node:fs";
import { runBaseSeed } from "../src/seed/base-seed";
import { SirutaImportError } from "../src/geo/siruta-data";
import { importSirutaDerived } from "../src/geo/siruta-store";
import { getDb, invalidateConfigCaches, loadRootEnv } from "./_runtime";

loadRootEnv();
const db = getDb();

try {
  const result = await db.$transaction((tx) => runBaseSeed(tx));
  // Nomenclatorul SIRUTA (județe și localități) din fișierul derivat din repo: idempotent, tot sau nimic.
  const siruta = await importSirutaDerived(
    db,
    JSON.parse(
      readFileSync(new URL("../data/siruta/siruta-s1-2026.json", import.meta.url), "utf8"),
    ),
  );
  const cacheCleared = await invalidateConfigCaches();
  console.log("Seed de bază aplicat (valorile noi adăugate; cele existente rămân neschimbate):");
  console.log(`  permisiuni noi:        ${result.permissions}`);
  console.log(`  roluri noi:            ${result.roles}`);
  console.log(`  legături rol-permisiune noi: ${result.rolePermissions}`);
  console.log(`  setări noi:            ${result.settings}`);
  console.log(`  flag-uri noi (oprite): ${result.featureFlags}`);
  console.log(
    `  SIRUTA ${siruta.version}:       ${siruta.inserted} noi, ${siruta.updated} actualizate, ${siruta.deactivated} dezactivate, ${siruta.unchanged} neschimbate`,
  );
  console.log(`  branding implicit:     ${result.brandingCreated ? "creat" : "există deja"}`);
  console.log(
    `  cache Redis:           ${cacheCleared ? "golit" : "indisponibil (expiră singur)"}`,
  );
} catch (error) {
  if (error instanceof SirutaImportError) {
    console.error(error.message);
    for (const problem of error.problems.slice(0, 10)) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await db.$disconnect();
}
