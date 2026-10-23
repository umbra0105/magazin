/**
 * Operare manuală a joburilor de stoc, pe baza din `.env`: rulează un job O SINGURĂ DATĂ sau arată starea.
 *
 *   npm.cmd run stock:jobs -- status          # rezervări de eliberat, prospețimea pozei, cereri «Anunță-mă» vechi
 *   npm.cmd run stock:jobs -- expire          # eliberează acum rezervările cu termenul trecut
 *   npm.cmd run stock:jobs -- snapshot-check  # verifică prospețimea pozei (scrie în audit doar la trecere/memento)
 *   npm.cmd run stock:jobs -- cleanup         # șterge cererile «Anunță-mă» vechi
 *
 * Aceleași funcții ca în workerul programat (`pnpm worker`), deci rezultatul e cel pe care l-ar da jobul. Sunt idempotente:
 * rulate de două ori sau în paralel cu workerul nu fac nimic în plus. `status` doar citește. Mesajele conțin numai numere.
 */
import { getDb } from "@ecom/db";
import { createStockJobsFromEnv, type StockJobName } from "../src/stock-jobs";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}

const hours = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });

const COMMANDS: Record<string, StockJobName | "status"> = {
  status: "status",
  expire: "stock-expire-reservations",
  "snapshot-check": "stock-snapshot-freshness",
  cleanup: "stock-alerts-cleanup",
};

const command = process.argv[2] ?? "";
const target = COMMANDS[command];
if (!target) {
  console.error("Folosire: npm.cmd run stock:jobs -- <status | expire | snapshot-check | cleanup>");
  process.exit(1);
}

const jobs = createStockJobsFromEnv();
const db = getDb();
let exitCode = 0;

try {
  const settings = await jobs.readSettings();
  if (target === "status") {
    const now = new Date();
    const [due, active, nextExpiry, oldUnsent, total] = await Promise.all([
      db.stockReservation.count({ where: { status: "active", expiresAt: { lte: now } } }),
      db.stockReservation.count({ where: { status: "active" } }),
      db.stockReservation.findFirst({
        where: { status: "active", expiresAt: { gt: now } },
        orderBy: { expiresAt: "asc" },
        select: { expiresAt: true },
      }),
      db.backInStockAlert.count({
        where: {
          notifiedAt: null,
          createdAt: {
            lt: new Date(now.getTime() - settings.backInStockRetentionDays * 86_400_000),
          },
        },
      }),
      db.backInStockAlert.count(),
    ]);
    console.log(`Ora acum:                          ${now.toISOString()}`);
    console.log(`Rezervări active:                  ${active}`);
    console.log(
      `  din care cu termenul trecut:     ${due}  (jobul de expirare le eliberează la următoarea rulare, cel mult 60 s)`,
    );
    console.log(
      `  următoarea expirare:             ${nextExpiry ? nextExpiry.expiresAt.toISOString() : "—"}`,
    );
    console.log(
      `Cereri «Anunță-mă»:                ${total}, din care mai vechi de ${settings.backInStockRetentionDays} zile: ${oldUnsent}`,
    );
    const warehouses = await jobs.maintenance.getSnapshotFreshness({
      staleHours: settings.snapshotStaleHours,
    });
    if (warehouses.length === 0) {
      console.log("Depozite cu stoc gestionat:        niciunul");
    }
    for (const w of warehouses) {
      const age =
        w.ageHours === null
          ? "nicio poză"
          : `poza de la ${w.takenAt?.toISOString()} (${hours.format(w.ageHours)} h)`;
      console.log(
        `Depozit «${w.name}»:`.padEnd(35) +
          `${w.status === "fresh" ? "proaspătă" : w.status === "stale" ? "VECHE" : "FĂRĂ POZĂ"}, ${age}, prag ${settings.snapshotStaleHours} h`,
      );
    }
  } else {
    const definition = jobs.definitions.find((d) => d.name === target);
    if (!definition) throw new Error(`Jobul ${target} nu există`);
    const started = Date.now();
    const result = await definition.run();
    const summary = definition.summarize ? definition.summarize(result) : null;
    console.log(
      summary
        ? `${target}: ${JSON.stringify(summary)} (${Date.now() - started} ms)`
        : `${target}: nimic de făcut (${Date.now() - started} ms)`,
    );
  }
} catch (error) {
  console.error(`Eșec: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  jobs.close();
  await db.$disconnect();
}
process.exit(exitCode);
