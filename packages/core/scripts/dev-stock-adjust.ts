/**
 * Demonstrație de dezvoltare a ajustărilor de stoc cu ora efectivă (Faza 5, punctul 6). Rulează pe baza de TEST
 * (`ecom_test`, niciodată pe cea de dezvoltare), cu conexiuni reale; datele create se șterg la final.
 *
 *   npm.cmd run dev:stock-adjust
 *
 * Arată: ajustarea și registrul de mișcări, refuzul sub zero, precizia unității, semnul după motiv și cronologia din plan
 * (D1.4): vânzarea din magazin de la 11:00 trăiește până la poza care o conține. Cere ca baza de test să fie migrată.
 */
import { createDbClient } from "@ecom/db";
import { formatQuantity, parseQuantity, parseSignedDelta, type Quantity } from "@ecom/shared";
import { assertTestDatabase, deriveTestDatabaseUrl } from "../../../test/support/test-env";
import { ADJUSTMENT_REASON_LABELS } from "../src/inventory/adjustment-rules";
import type { AdjustmentReason } from "../src/inventory/constants";
import { StockService, type AdjustPhysicalResult } from "../src/inventory/stock-service";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  type ProductSpec,
  type StockContext,
} from "../src/test-utils/stock-fixtures";
import { loadRootEnv } from "./_runtime";

loadRootEnv();
const devUrl = process.env["DATABASE_URL"];
if (!devUrl) throw new Error("DATABASE_URL lipsește (.env)");
const testUrl = deriveTestDatabaseUrl(devUrl, process.env["TEST_DATABASE_URL"]);
assertTestDatabase(testUrl);
process.env["DATABASE_URL"] = testUrl;

const db = createDbClient({ max: 40 });
const service = new StockService({ db });
const q = (text: string): Quantity => parseQuantity(text);
const hour = (base: Date, h: number): Date => new Date(base.getTime() + h * 3_600_000);
const clock = (date: Date): string => date.toISOString().slice(11, 16);

async function scenario(
  title: string,
  spec: ProductSpec,
  run: (ctx: StockContext, variantId: string) => Promise<string[]>,
): Promise<void> {
  const ctx = await createStockContext(db);
  try {
    const created = await addStockProduct(db, ctx, spec);
    const lines = await run(ctx, created.variants[0]!.id);
    console.log(`${title}\n${lines.map((l) => `    → ${l}`).join("\n")}\n`);
  } finally {
    await purgeStockContext(db, ctx);
  }
}

const physicalOf = async (ctx: StockContext, variantId: string): Promise<string> => {
  const row = await db.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
  });
  return formatQuantity(row.physical as Quantity);
};

function adjust(
  ctx: StockContext,
  variantId: string,
  delta: string,
  reason: AdjustmentReason,
  effectiveAt?: Date,
): Promise<AdjustPhysicalResult> {
  return service.adjustPhysical({
    variantId,
    warehouseId: ctx.warehouseId,
    delta: parseSignedDelta(delta),
    reason,
    note: "demonstrație",
    ...(effectiveAt && { effectiveAt }),
    actor: { id: "dev", label: "dev@magazin.test" },
  });
}

async function refused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ACCEPTAT";
  } catch (error) {
    return `refuzat (${(error as { code?: string }).code ?? "eroare"})`;
  }
}

console.log(`Baza de test: ${new URL(testUrl).pathname.slice(1)}\n`);

await scenario(
  "Ajustare și registru: stoc 10, «Vânzare în magazin» −3",
  { variants: [{ physical: "10" }] },
  async (ctx, id) => {
    const result = await adjust(ctx, id, "-3", "sale_in_store");
    const moves = await db.stockMovement.findMany({ where: { variantId: id } });
    return [
      `stoc ${formatQuantity(result.physicalBefore)} → ${formatQuantity(result.physicalAfter)}`,
      `registru: ${moves.length} mișcare, motiv «${ADJUSTMENT_REASON_LABELS[moves[0]!.reason as AdjustmentReason]}», fizic după ${formatQuantity(moves[0]!.physicalAfter as Quantity)}`,
    ];
  },
);

await scenario("Refuz sub zero: stoc 2", { variants: [{ physical: "2" }] }, async (ctx, id) => [
  `−3 «Deteriorat»: ${await refused(() => adjust(ctx, id, "-3", "damaged"))}`,
  `stoc rămas: ${await physicalOf(ctx, id)}`,
  `−2 «Deteriorat» (exact până la 0): ${await refused(() => adjust(ctx, id, "-2", "damaged"))}, stoc ${await physicalOf(ctx, id)}`,
]);

await scenario(
  "Precizia unității: bucăți (0 zecimale)",
  { variants: [{ physical: "5" }] },
  async (ctx, id) => [
    `+2 buc: ${await refused(() => adjust(ctx, id, "+2", "receipt"))}`,
    `+0,5 buc: ${await refused(() => adjust(ctx, id, "+0,5", "receipt"))}`,
  ],
);

await scenario(
  "Pasul de vânzare nu limitează: rolă de 41,25 mp, stoc 100",
  { step: "41,25", variants: [{ physical: "100" }] },
  async (ctx, id) => [
    `−1 mp «Deteriorat» (nu e multiplu de 41,25): ${await refused(() => adjust(ctx, id, "-1", "damaged"))}, stoc ${await physicalOf(ctx, id)}`,
  ],
);

await scenario("Semnul după motiv", { variants: [{ physical: "10" }] }, async (ctx, id) => [
  `«Vânzare în magazin» +1: ${await refused(() => adjust(ctx, id, "+1", "sale_in_store"))}`,
  `«Recepție marfă» −1: ${await refused(() => adjust(ctx, id, "-1", "receipt"))}`,
  `«Retur» −1: ${await refused(() => adjust(ctx, id, "-1", "return"))}`,
]);

await scenario(
  "Cronologia din plan (D1.4): vânzarea din magazin trăiește până la poza care o conține",
  { variants: [{ physical: null }] },
  async (ctx, id) => {
    const base = hour(new Date(), -5);
    const lines: string[] = [];
    const photo = async (takenAt: Date, quantity: string) => {
      const snapshot = await db.stockSnapshot.create({
        data: { warehouseId: ctx.warehouseId, takenAt, source: "import" },
      });
      ctx.snapshotIds.push(snapshot.id);
      await service.applySnapshot({
        variantId: id,
        warehouseId: ctx.warehouseId,
        snapshotId: snapshot.id,
        quantity: q(quantity),
        takenAt,
        safetyWindowMinutes: 30,
      });
    };
    await photo(hour(base, 0), "4");
    lines.push(
      `poza de la ${clock(hour(base, 0))} (SmartBill: 4) → stoc ${await physicalOf(ctx, id)}`,
    );
    await adjust(ctx, id, "-1", "sale_in_store", hour(base, 1));
    lines.push(
      `vânzare în magazin la ${clock(hour(base, 1))}, notată după → stoc ${await physicalOf(ctx, id)}`,
    );
    await photo(hour(base, 0.5), "4");
    lines.push(
      `poza de la ${clock(hour(base, 0.5))} (SmartBill: 4, dinaintea vânzării) → stoc ${await physicalOf(ctx, id)} (vânzarea rămâne)`,
    );
    await photo(hour(base, 2), "3");
    lines.push(
      `poza de la ${clock(hour(base, 2))} (SmartBill: 3, conține vânzarea) → stoc ${await physicalOf(ctx, id)} (nu 2: nu se scade de două ori)`,
    );
    return lines;
  },
);

await scenario(
  "Ora efectivă dinaintea pozei deja aplicate → avertisment",
  { variants: [{ physical: null }] },
  async (ctx, id) => {
    const base = hour(new Date(), -3);
    const snapshot = await db.stockSnapshot.create({
      data: { warehouseId: ctx.warehouseId, takenAt: base, source: "import" },
    });
    ctx.snapshotIds.push(snapshot.id);
    await service.applySnapshot({
      variantId: id,
      warehouseId: ctx.warehouseId,
      snapshotId: snapshot.id,
      quantity: q("4"),
      takenAt: base,
      safetyWindowMinutes: 30,
    });
    const result = await adjust(ctx, id, "-1", "sale_in_store", hour(base, -0.5));
    return [
      `vânzare la ${clock(hour(base, -0.5))}, poza e de la ${clock(base)}: avertismente = [${result.warnings.join(", ")}], stoc ${formatQuantity(result.physicalAfter)}`,
    ];
  },
);

await scenario(
  "10 vânzări deodată pe stoc 5 (conexiuni separate)",
  { variants: [{ physical: "5" }] },
  async (ctx, id) => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => adjust(ctx, id, "-1", "sale_in_store")),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    return [`${ok} reușite, ${results.length - ok} refuzate; stoc ${await physicalOf(ctx, id)}`];
  },
);

await db.$disconnect();
