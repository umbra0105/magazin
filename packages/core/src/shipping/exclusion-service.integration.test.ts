import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { FreeShippingExclusionService } from "./exclusion-service";

const db = getDb();
afterAll(() => db.$disconnect());

const uid = (): string => randomUUID().slice(0, 8);

async function product(tx: TestTx) {
  const created = await tx.product.create({
    data: { slug: `p-${uid()}`, title: `Pompă ${uid()}` },
  });
  const variant = await tx.productVariant.create({
    data: {
      productId: created.id,
      sku: `EXCL-${uid()}`.toUpperCase(),
      price: 10_000,
      isDefault: true,
    },
  });
  return { productId: created.id, sku: variant.sku, title: created.title };
}

describe("produse excluse de la transportul gratuit", () => {
  it("adaugă după SKU (fără deosebire de litere), idempotent, și listează cu titlu și SKU", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new FreeShippingExclusionService(tx);
      const p = await product(tx);
      const first = await service.addBySku(` ${p.sku.toLowerCase()} `);
      expect(first).toEqual({ productId: p.productId, title: p.title, sku: p.sku });
      await service.addBySku(p.sku);
      expect((await service.list()).filter((e) => e.productId === p.productId)).toHaveLength(1);
    });
  });

  it("un SKU necunoscut sau gol se refuză cu cod stabil", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new FreeShippingExclusionService(tx);
      for (const sku of ["", "   ", "NU-EXISTA-" + uid()]) {
        await expect(service.addBySku(sku), sku).rejects.toMatchObject({
          code: "FREE_SHIPPING_SKU_NOT_FOUND",
        });
      }
    });
  });

  it("un produs șters (soft) nu se poate adăuga", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new FreeShippingExclusionService(tx);
      const p = await product(tx);
      await tx.product.update({ where: { id: p.productId }, data: { deletedAt: new Date() } });
      await expect(service.addBySku(p.sku)).rejects.toMatchObject({
        code: "FREE_SHIPPING_SKU_NOT_FOUND",
      });
    });
  });

  it("scoate excluderea; a doua scoatere dă false; excluderea dispare odată cu produsul (cascadă)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const service = new FreeShippingExclusionService(tx);
      const a = await product(tx);
      const b = await product(tx);
      await service.addBySku(a.sku);
      await service.addBySku(b.sku);
      expect(await service.remove(a.productId)).toBe(true);
      expect(await service.remove(a.productId)).toBe(false);
      await tx.product.delete({ where: { id: b.productId } });
      expect((await service.list()).map((e) => e.productId)).not.toContain(b.productId);
    });
  });
});
