import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { lowestPriceInWindow } from "./price-history";
import { snapshotPriceHistory } from "./price-snapshot";

const db = getDb();
afterAll(() => db.$disconnect());

const NOW = new Date("2030-06-15T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);
const uid = (): string => randomUUID().slice(0, 8);

async function variant(
  tx: TestTx,
  data: { price: number; salePrice?: number; start?: Date; end?: Date; deleted?: boolean },
) {
  const product = await tx.product.create({
    data: {
      slug: `pp-${uid()}`,
      title: "Produs",
      deletedAt: data.deleted ? NOW : null,
      variants: {
        create: {
          sku: `SKU-${uid()}`,
          price: data.price,
          salePrice: data.salePrice ?? null,
          saleStartsAt: data.start ?? null,
          saleEndsAt: data.end ?? null,
          isDefault: true,
        },
      },
    },
    select: { variants: { select: { id: true } } },
  });
  return product.variants[0]!.id;
}

const history = (tx: TestTx, variantId: string) =>
  tx.priceHistory.findMany({ where: { variantId }, orderBy: { effectiveFrom: "asc" } });

describe("snapshotPriceHistory (jobul zilnic, Postgres real)", () => {
  it("prima rulare scrie un punct la momentul rulării; a doua rulare nu scrie nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const id = await variant(tx, { price: 10000 });
      await snapshotPriceHistory(tx, NOW);
      expect((await history(tx, id)).map((p) => [p.price, p.effectiveFrom.getTime()])).toEqual([
        [10000, NOW.getTime()],
      ]);
      const again = await snapshotPriceHistory(tx, new Date(NOW.getTime() + 1000));
      expect(again.written).toBe(0);
      expect(await history(tx, id)).toHaveLength(1);
    });
  });

  it("tranzițiile programate dintre rulări se scriu la momentul lor, iar «cel mai mic preț din 30 de zile» le vede", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      // punctul inițial acum 20 de zile; promoția 7000 între acum 5 zile și acum 2 zile; rulare azi
      const id = await variant(tx, { price: 10000, salePrice: 7000, start: at(-5), end: at(-2) });
      await tx.priceHistory.create({
        data: { variantId: id, price: 10000, effectiveFrom: at(-20) },
      });
      const result = await snapshotPriceHistory(tx, NOW);
      expect(result.written).toBe(2);
      const points = await history(tx, id);
      expect(points.map((p) => [p.price, p.effectiveFrom.getTime()])).toEqual([
        [10000, at(-20).getTime()],
        [7000, at(-5).getTime()],
        [10000, at(-2).getTime()],
      ]);
      // cel mai mic preț din ultimele 30 de zile de azi: 7000 (promoția din interval)
      expect(
        lowestPriceInWindow(
          points.map((p) => ({ price: p.price, effectiveFrom: p.effectiveFrom })),
          { until: NOW },
        ),
      ).toBe(7000);
    });
  });

  it("produsele șterse nu intră; costul nu e atins (doar câmpurile de preț public)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const gone = await variant(tx, { price: 5000, deleted: true });
      await snapshotPriceHistory(tx, NOW);
      expect(await history(tx, gone)).toHaveLength(0);
    });
  });

  it("mai multe variante: toate primesc punctul inițial", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await variant(tx, { price: 1000 + i }));
      const result = await snapshotPriceHistory(tx, NOW);
      expect(result.variants).toBeGreaterThanOrEqual(3);
      for (const id of ids) expect(await history(tx, id)).toHaveLength(1);
    });
  });
});
