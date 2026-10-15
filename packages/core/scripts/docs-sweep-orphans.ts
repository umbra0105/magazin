/**
 * Fișiere de documente rămase fără rând: `npm run docs:sweep-orphans` (doar raport) sau
 * `npm run docs:sweep-orphans -- --delete` (șterge orfanii).
 *
 * Operează STRICT pe `private/product-documents/` (nu atinge niciodată `public/` sau alte prefixe),
 * compară cu rândurile din `product_document` și lasă în pace obiectele mai noi de 1 oră (un upload în
 * curs). Fără `--delete` nu modifică nimic. Nu afișează chei complete cu nume de utilizator, conținut,
 * credențiale sau adrese de conexiune: doar cheile obiectelor (uuid + extensie), mărimea și data.
 */
import { loadEnv } from "@ecom/config";
import { createStorage } from "@ecom/integrations";
import {
  createPrismaProductDocumentStore,
  sweepOrphanDocuments,
} from "../src/catalog/product-documents";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const args = process.argv.slice(2);
const doDelete = args.includes("--delete");
const unknown = args.filter((a) => a !== "--delete");
if (unknown.length > 0) {
  console.error("Folosire: npm run docs:sweep-orphans [-- --delete]");
  process.exit(1);
}

const db = getDb();
try {
  const storage = createStorage(loadEnv());
  const report = await sweepOrphanDocuments({
    storage,
    store: createPrismaProductDocumentStore(db),
    delete: doDelete,
  });
  console.log(
    `Obiecte în private/product-documents/: ${report.scanned}${report.truncated ? " (listă trunchiată)" : ""}`,
  );
  console.log(`Fără rând în baza de date și mai vechi de 1 oră: ${report.orphans.length}`);
  console.log(`Fără rând, dar prea noi (nu se ating): ${report.tooRecent}`);
  for (const o of report.orphans) {
    console.log(`  ${o.key}  ${o.size} octeți  ${o.lastModified.toISOString()}`);
  }
  if (doDelete) console.log(`Șterse: ${report.deleted.length}`);
  else if (report.orphans.length > 0) console.log("Doar raport. Pentru ștergere: -- --delete");
} catch (error) {
  console.error("Curățarea a eșuat:", error instanceof Error ? error.name : "eroare");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
