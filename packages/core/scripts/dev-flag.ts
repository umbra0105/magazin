/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din produs): pornește sau oprește un steag de funcționalitate, până vine ecranul de
 * Setări (Faza 16). Regulile (steaguri doar din registru, scriere doar prin FeatureFlagService, audit cu actorul „script de
 * dezvoltare”, refuz în afara bazei și a Redis-ului locale) stau în `src/features/dev-flag.ts`, unde sunt testate.
 *
 *   npm.cmd run dev:flag                              # arată starea tuturor steagurilor (doar citire)
 *   npm.cmd run dev:flag -- multiWarehouse on         # pornește steagul și șterge imediat cache-ul din Redis
 *   npm.cmd run dev:flag -- multiWarehouse off        # îl oprește la loc
 *
 * Scrie doar în `feature_flag` și `audit_log`. Nu afișează adrese de conexiune, utilizatori sau parole. Dev serverul nu trebuie
 * repornit: schimbarea se vede la următoarea cerere.
 */
import { Redis } from "ioredis";
import { DomainError } from "@ecom/shared";
import { createPrismaAuditStore } from "../src/audit";
import {
  assertDevFlagEnvironment,
  formatDevFlagResult,
  parseDevFlagArgs,
  runDevFlag,
} from "../src/features/dev-flag";
import { createPrismaFeatureFlagStore } from "../src/features/prisma-store";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

try {
  const command = parseDevFlagArgs(process.argv.slice(2));
  // Înainte de orice conexiune: refuză baza/Redis-ul care nu sunt locale și mediul de producție.
  assertDevFlagEnvironment(process.env);

  const db = getDb();
  const redis = new Redis(process.env["REDIS_URL"] ?? "", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  redis.on("error", () => undefined);
  try {
    const result = await runDevFlag({
      command,
      store: createPrismaFeatureFlagStore(db),
      redis,
      auditStore: createPrismaAuditStore(db),
    });
    for (const line of formatDevFlagResult(result)) console.log(line);
    if (result.kind === "set" && !result.cacheCleared) process.exitCode = 1;
  } finally {
    redis.disconnect();
    await db.$disconnect();
  }
} catch (error) {
  // Doar mesajele noastre (fără adrese). Alte erori pot purta detalii de conexiune: afișăm doar tipul lor.
  if (error instanceof DomainError) {
    console.error(error.message);
  } else {
    const name = error instanceof Error ? error.name : "necunoscută";
    console.error(`Eroare neașteptată (${name}). Verifică dacă Postgres și Redis rulează.`);
  }
  process.exitCode = 1;
}
