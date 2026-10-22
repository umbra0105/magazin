/**
 * Demonstrație de dezvoltare a concurenței la stoc (Faza 5, punctul 5). Rulează pe baza de TEST (`ecom_test`, niciodată pe
 * cea de dezvoltare), cu conexiuni reale și separate, și arată câte cereri deodată reușesc. Datele create se șterg la final.
 *
 *   npm.cmd run dev:stock-race
 *
 * Cere ca baza de test să fie migrată (o pregătește orice rulare a testelor de integrare).
 */
import { createDbClient } from "@ecom/db";
import { formatQuantity, parseQuantity, type Quantity } from "@ecom/shared";
import { assertTestDatabase, deriveTestDatabaseUrl } from "../../../test/support/test-env";
import { StockService, type LineOutcome } from "../src/inventory/stock-service";
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
const soon = (): Date => new Date(Date.now() + 15 * 60_000);

async function scenario(
  title: string,
  spec: ProductSpec,
  run: (ctx: StockContext, variantIds: string[]) => Promise<string>,
): Promise<void> {
  const ctx = await createStockContext(db);
  try {
    const created = await addStockProduct(db, ctx, spec);
    const result = await run(
      ctx,
      created.variants.map((v) => v.id),
    );
    console.log(`${title}\n    → ${result}\n`);
  } finally {
    await purgeStockContext(db, ctx);
  }
}

async function settle<T>(count: number, fn: (index: number) => Promise<T>) {
  const results = await Promise.allSettled(Array.from({ length: count }, (_, index) => fn(index)));
  return {
    ok: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}

const reservedOf = async (ctx: StockContext, variantId: string): Promise<string> => {
  const row = await db.inventoryItem.findUniqueOrThrow({
    where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
  });
  return `rezervat ${formatQuantity(row.reserved as Quantity)}, angajat ${formatQuantity(row.committed as Quantity)}`;
};

console.log(
  `Baza de test: ${new URL(testUrl).pathname.slice(1)} (conexiuni separate, tranzacții reale)\n`,
);

await scenario(
  "10 cereri deodată pe ultima bucată (stoc 1)",
  { variants: [{ physical: "1" }] },
  async (ctx, [id]) => {
    const r = await settle(10, (i) =>
      service.reserve(
        { refType: "order", refId: `${ctx.tag}-${i}` },
        [{ variantId: id!, warehouseId: ctx.warehouseId, quantity: q("1") }],
        soon(),
      ),
    );
    return `${r.ok} reușită, ${r.failed} refuzate; ${await reservedOf(ctx, id!)}`;
  },
);

await scenario(
  "100 de cereri deodată pe stoc 10",
  { variants: [{ physical: "10" }] },
  async (ctx, [id]) => {
    const r = await settle(100, (i) =>
      service.reserve(
        { refType: "order", refId: `${ctx.tag}-${i}` },
        [{ variantId: id!, warehouseId: ctx.warehouseId, quantity: q("1") }],
        soon(),
      ),
    );
    return `${r.ok} reușite, ${r.failed} refuzate; ${await reservedOf(ctx, id!)}`;
  },
);

await scenario(
  "10 cereri de 0,3 pe stoc 1,0 (pas 0,3)",
  { step: "0,3", variants: [{ physical: "1" }] },
  async (ctx, [id]) => {
    const r = await settle(10, (i) =>
      service.reserve(
        { refType: "order", refId: `${ctx.tag}-${i}` },
        [{ variantId: id!, warehouseId: ctx.warehouseId, quantity: q("0,3") }],
        soon(),
      ),
    );
    return `${r.ok} reușite, ${r.failed} refuzate; ${await reservedOf(ctx, id!)} (rămân 0,1 nevandabile)`;
  },
);

await scenario(
  "liner: 5 cereri de câte o rolă (41,25 mp) pe 100 mp",
  { step: "41,25", variants: [{ physical: "100" }] },
  async (ctx, [id]) => {
    const r = await settle(5, (i) =>
      service.reserve(
        { refType: "order", refId: `${ctx.tag}-${i}` },
        [{ variantId: id!, warehouseId: ctx.warehouseId, quantity: q("41,25") }],
        soon(),
      ),
    );
    return `${r.ok} reușite, ${r.failed} refuzate; ${await reservedOf(ctx, id!)} (rest nevandabil 17,5)`;
  },
);

await scenario(
  "coșuri A,B și B,A deodată, stoc 1 + 1",
  { variants: [{ physical: "1" }, { physical: "1" }] },
  async (ctx, [a, b]) => {
    const r = await settle(20, (i) => {
      const lines = [a!, b!].map((variantId) => ({
        variantId,
        warehouseId: ctx.warehouseId,
        quantity: q("1"),
      }));
      return service.reserve(
        { refType: "order", refId: `${ctx.tag}-${i}` },
        i % 2 === 0 ? lines : lines.reverse(),
        soon(),
      );
    });
    return `${r.ok} coș întreg reușit, ${r.failed} refuzate (fără deadlock, fără rezervări parțiale); A: ${await reservedOf(ctx, a!)}; B: ${await reservedOf(ctx, b!)}`;
  },
);

await scenario(
  "webhook dublu: 8 confirmări simultane ale aceleiași plăți",
  { variants: [{ physical: "5" }] },
  async (ctx, [id]) => {
    const ref = { refType: "order", refId: `${ctx.tag}-plata` };
    await service.reserve(
      ref,
      [{ variantId: id!, warehouseId: ctx.warehouseId, quantity: q("2") }],
      soon(),
    );
    const outcomes: LineOutcome[][] = await Promise.all(
      Array.from({ length: 8 }, () => service.confirmReservation(ref)),
    );
    const kinds = outcomes.flat().map((o) => o.outcome);
    return `${kinds.filter((k) => k === "committed").length} angajare, ${kinds.filter((k) => k === "already_committed").length} «deja angajată»; ${await reservedOf(ctx, id!)}`;
  },
);

await scenario(
  "confirmare simultană cu expirarea (10 curse)",
  { variants: [{ physical: "20" }] },
  async (ctx, [id]) => {
    let exact = 0;
    for (let round = 0; round < 10; round++) {
      const ref = { refType: "order", refId: `${ctx.tag}-cursa${round}` };
      await service.reserve(
        ref,
        [{ variantId: id!, warehouseId: ctx.warehouseId, quantity: q("1") }],
        new Date(Date.now() - 1_000),
      );
      await Promise.all([
        service.confirmReservation(ref),
        service.expireDue({ variantIds: [id!] }),
      ]);
      const count = await db.stockCommitment.count({ where: { refId: ref.refId } });
      if (count === 1) exact++;
    }
    return `${exact}/10 curse cu EXACT o angajare; ${await reservedOf(ctx, id!)} (așteptat: rezervat 0, angajat 10)`;
  },
);

await db.$disconnect();
