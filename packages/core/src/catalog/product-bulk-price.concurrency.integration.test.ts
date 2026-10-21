import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { ProductService } from "./product-service";
import { createPrismaProductStore, type ProductStore } from "./product-store";

/**
 * Blocul C, C-14, pe Postgres real: ajustarea de preț în masă citea prețurile, calcula valori ABSOLUTE și le scria într-o
 * tranzacție ulterioară, fără nicio verificare: o editare de preț făcută de alt administrator între citire și scriere se
 * pierdea în tăcere (și istoricul de preț se calcula din prețul vechi). Acum fiecare actualizare cere ca prețul și promoția să
 * fie încă cele citite; altfel întreaga operație se oprește (tot sau nimic) cu un mesaj clar.
 */

const db = getDb();
const subject: PermissionSubject = {
  userId: "u-bulk",
  email: "bulk@magazin.test",
  roles: ["manager"],
  permissions: new Set(["admin.access", "products.write"]),
};
const created: string[] = [];

afterAll(async () => {
  await db.product.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

const serviceOver = (store: ProductStore) =>
  new ProductService({
    store,
    audit: new AuditService({ append: async () => undefined, list: async () => [] }),
    defaultManageStock: async () => true,
    logger: createLogger({ destination: { write() {} } }),
  });

async function product(tag: string, i: number, price: number) {
  const row = await db.product.create({
    data: {
      slug: `zz-bulk-${tag}-${i}`,
      title: `ZZ bulk ${tag} ${i}`,
      variants: {
        create: [{ sku: `ZZ-BULK-${tag}-${i}`, price, position: 0, isDefault: true }],
      },
    },
    select: { id: true, variants: { select: { id: true } } },
  });
  created.push(row.id);
  return { id: row.id, variantId: row.variants[0]?.id as string };
}

const request = (ids: string[]) => ({
  ids,
  confirm: true as const,
  expectedCount: ids.length,
  changes: { priceAdjustBps: 1000 }, // +10%
});

describe("ajustarea de preț în masă: editare simultană (Postgres real)", () => {
  it("o editare de preț făcută între citire și scriere NU se pierde: operația se oprește, nimic nu se schimbă", async () => {
    const tag = randomUUID().slice(0, 8);
    const a = await product(tag, 1, 10_000);
    const b = await product(tag, 2, 20_000);
    const real = createPrismaProductStore(db);
    const store: ProductStore = {
      ...real,
      async bulkApply(command) {
        // alt administrator editează prețul produsului A după ce ajustarea l-a citit (10.000) și înainte să scrie
        await db.productVariant.update({ where: { id: a.variantId }, data: { price: 15_000 } });
        return real.bulkApply(command);
      },
    };
    const error = await serviceOver(store)
      .bulkUpdate(subject, request([a.id, b.id]))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "CATALOG_BULK_CONFLICT" });
    const prices = await db.productVariant.findMany({
      where: { id: { in: [a.variantId, b.variantId] } },
      select: { id: true, price: true },
    });
    const byId = new Map(prices.map((p) => [p.id, p.price]));
    expect(byId.get(a.variantId)).toBe(15_000); // editarea concurentă a rămas
    expect(byId.get(b.variantId)).toBe(20_000); // tot sau nimic: nici B nu s-a ajustat
  });

  it("fără editare concurentă, ajustarea merge: +10% pe fiecare variantă", async () => {
    const tag = randomUUID().slice(0, 8);
    const a = await product(tag, 1, 10_000);
    const b = await product(tag, 2, 20_000);
    const result = await serviceOver(createPrismaProductStore(db)).bulkUpdate(
      subject,
      request([a.id, b.id]),
    );
    expect(result).toMatchObject({ updatedProducts: 2, updatedVariants: 2 });
    const prices = await db.productVariant.findMany({
      where: { id: { in: [a.variantId, b.variantId] } },
      select: { id: true, price: true },
    });
    const byId = new Map(prices.map((p) => [p.id, p.price]));
    expect(byId.get(a.variantId)).toBe(11_000);
    expect(byId.get(b.variantId)).toBe(22_000);
  });
});
