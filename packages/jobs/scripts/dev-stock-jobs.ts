/**
 * Demonstrație de dezvoltare a joburilor de stoc (Faza 5, punctul 7), pe baza de TEST (`ecom_test`, niciodată pe cea de
 * dezvoltare). Pornește joburile REALE din `stock-jobs.ts`, doar cu intervale scurte, și arată în timp real că:
 *
 *   1. o rezervare cu termen scurt se eliberează SINGURĂ și disponibilitatea revine (proba din plan);
 *   2. o poză SmartBill veche produce o alertă (o singură dată), iar una nouă produce refacerea;
 *   3. cererile «Anunță-mă» vechi se șterg.
 *
 *   npm.cmd run dev:stock-jobs            # rezervarea expiră în 12 secunde
 *   npm.cmd run dev:stock-jobs -- 30      # rezervarea expiră în 30 de secunde
 *
 * Datele create se șterg la final. Jurnalul de audit al demonstrației e în memorie (audit_log nu se poate curăța).
 */
import { AuditService, StockMaintenance, StockService } from "@ecom/core";
import { createDbClient } from "@ecom/db";
import { formatQuantity, parseQuantity, type Quantity } from "@ecom/shared";
import { assertTestDatabase, deriveTestDatabaseUrl } from "../../../test/support/test-env";
import { MemoryAudit } from "../../core/src/test-utils/memory-audit";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
} from "../../core/src/test-utils/stock-fixtures";
import { buildStockJobs, startStockJobs } from "../src/stock-jobs";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // fără .env: variabilele vin din mediu
}
const devUrl = process.env["DATABASE_URL"];
if (!devUrl) throw new Error("DATABASE_URL lipsește (.env)");
const testUrl = deriveTestDatabaseUrl(devUrl, process.env["TEST_DATABASE_URL"]);
assertTestDatabase(testUrl);
process.env["DATABASE_URL"] = testUrl;

const seconds = Math.max(5, Math.min(120, Number.parseInt(process.argv[2] ?? "12", 10) || 12));
const TICK_MS = 4_000;
const db = createDbClient({ max: 10 });
const q = (text: string): Quantity => parseQuantity(text);
const started = Date.now();
const stamp = (): string =>
  `+${String(Math.floor((Date.now() - started) / 1000)).padStart(2, "0")} s`;
const say = (text: string): void => console.log(`${stamp()}  ${text}`);

const audit = new MemoryAudit();
const maintenance = new StockMaintenance({ db, audit: new AuditService(audit) });
const stock = new StockService({ db });
const ctx = await createStockContext(db);
let ok: boolean;

try {
  console.log(
    `Baza de test: ${new URL(testUrl).pathname.slice(1)}; intervalul demonstrației: ${TICK_MS / 1000} s (în producție: 60 s / 15 min / zilnic la 03:30)\n`,
  );
  const { variants } = await addStockProduct(db, ctx, { variants: [{ physical: "5" }] });
  const variantId = variants[0]!.id;
  const line = [{ variantId, warehouseId: ctx.warehouseId, quantity: q("2") }];

  const state = async (): Promise<string> => {
    const inventory = await stock.readInventory(variantId, ctx.warehouseId);
    const row = await db.inventoryItem.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
    });
    const free = formatQuantity(
      (inventory ? inventory.physical - inventory.committed - inventory.reserved : 0n) as Quantity,
    );
    return `rezervat în contor ${formatQuantity(row.reserved as Quantity)}, disponibil la citire ${free}`;
  };

  // 1) rezervare cu termen scurt
  await stock.reserve(
    { refType: "order", refId: `${ctx.tag}-demo` },
    line,
    new Date(Date.now() + seconds * 1000),
  );
  say(`rezervare de 2 buc creată, expiră în ${seconds} s → ${await state()}`);

  // 2) poză veche (30 h) pe depozit cu stoc
  const oldSnapshot = await db.stockSnapshot.create({
    data: {
      warehouseId: ctx.warehouseId,
      takenAt: new Date(Date.now() - 30 * 3_600_000),
      source: "import",
    },
  });
  ctx.snapshotIds.push(oldSnapshot.id);
  say("poza SmartBill a depozitului e veche de 30 h (pragul e de 24 h)");

  // 3) cereri «Anunță-mă» vechi
  await db.backInStockAlert.createMany({
    data: Array.from({ length: 3 }, (_, i) => ({
      variantId,
      email: `demo${i}@exemplu.test`,
      createdAt: new Date(Date.now() - 120 * 86_400_000),
    })),
  });
  say("3 cereri «Anunță-mă» vechi de 120 de zile (retenția e de 90)");

  // joburile REALE, cu aceleași funcții ca în worker, doar cu intervale scurte
  const logger = {
    info: (obj: object, msg: string) => say(`JOB  ${msg} ${JSON.stringify(obj)}`),
    warn: (obj: object, msg: string) => say(`JOB (avertisment) ${msg} ${JSON.stringify(obj)}`),
  };
  const definitions = buildStockJobs({
    maintenance,
    readSettings: async () => ({
      snapshotStaleHours: 24,
      backInStockRetentionDays: 90,
      timeZone: "Europe/Bucharest",
    }),
    logger,
  }).map((d) => ({ ...d, schedule: { everyMs: TICK_MS } }));
  const handle = startStockJobs(definitions, { logger, initialDelayMs: 1_000 });

  const deadline = Date.now() + (seconds + TICK_MS / 1000 + 4) * 1000;
  let announced = false;
  for (let tick = 0; Date.now() < deadline; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const now = await state();
    if (tick % 4 === 3) say(`stare: ${now}`);
    const row = await db.inventoryItem.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
    });
    if (row.reserved === 0n && !announced) {
      announced = true;
      say(`>>> rezervarea a fost eliberată SINGURĂ de job; disponibilitatea a revenit → ${now}`);
      // poza nouă → refacerea
      const fresh = await db.stockSnapshot.create({
        data: { warehouseId: ctx.warehouseId, takenAt: new Date(), source: "import" },
      });
      ctx.snapshotIds.push(fresh.id);
      say("a apărut o poză nouă; la următoarea verificare jobul scrie «refăcută»");
      await new Promise((resolve) => setTimeout(resolve, TICK_MS + 1_500));
      break;
    }
  }
  handle.close();

  const rows = audit.for(ctx.warehouseId).reverse();
  console.log("\nJurnal de audit (în memorie) pentru depozit:");
  for (const row of rows) console.log(`  ${row.action}  ${JSON.stringify(row.after)}`);
  const left = await db.backInStockAlert.count({ where: { variantId } });
  console.log(`\nCereri «Anunță-mă» rămase: ${left} (așteptat 0)`);
  ok =
    announced &&
    left === 0 &&
    rows.some((r) => r.action === "stock.snapshot.stale") &&
    rows.some((r) => r.action === "stock.snapshot.recovered");
  console.log(
    ok
      ? "\nREUȘIT: expirare, alertă, refacere și curățare au rulat singure."
      : "\nATENȚIE: ceva nu s-a întâmplat la timp (vezi mai sus).",
  );
} finally {
  await purgeStockContext(db, ctx);
  await db.$disconnect();
}
process.exit(ok ? 0 : 1);
