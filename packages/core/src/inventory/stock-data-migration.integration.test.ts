import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 5, punctul 14 (gol găsit la acoperire): migrarea de DATE din `stock_foundation` (D2: inventarul îl face
 * utilizatorul, deci produsele și variantele EXISTENTE fără niciun rând de stoc trec pe «negestionat») nu avea niciun test.
 * O migrație rulează o singură dată, la instalare, deci nu se poate repeta pe baza de test; testul citește instrucțiunile
 * din fișierul migrației (cele două UPDATE-uri de după marcajul «Migrare de date») și le rulează într-o tranzacție ANULATĂ,
 * pe produse create de test. Singura deosebire față de migrație: fiecare UPDATE primește în față condiția «doar rândurile
 * de test» (altfel ar bloca și ar atinge produsele altor teste); testul verifică întâi că forma instrucțiunilor e cea
 * așteptată, deci pică dacă migrația își schimbă forma.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

const MIGRATION = fileURLToPath(
  new URL(
    "../../../db/prisma/migrations/20261021090000_stock_foundation/migration.sql",
    import.meta.url,
  ),
);

const PRODUCT_WHERE = 'WHERE p."manageStock" = true';
const VARIANT_WHERE = 'WHERE v."manageStock" IS TRUE';

/** Cele două instrucțiuni ale migrării de date, restrânse la rândurile de test (parametrul $1 = ids) */
function dataMigration(): { product: string; variant: string } {
  const sql = readFileSync(MIGRATION, "utf8");
  const marker = sql.indexOf("Migrare de date (D2)");
  expect(marker, "marcajul «Migrare de date (D2)» din migrație").toBeGreaterThan(-1);
  const tail = sql.slice(marker);
  const statements = [...tail.matchAll(/^UPDATE [^;]*;/gm)].map((m) => m[0]);
  expect(statements, "două UPDATE-uri: produs și variantă").toHaveLength(2);
  const [product, variant] = statements as [string, string];
  expect(product).toContain('UPDATE "product" p');
  expect(product).toContain(PRODUCT_WHERE);
  expect(variant).toContain('UPDATE "product_variant" v');
  expect(variant).toContain(VARIANT_WHERE);
  return {
    product: product.replace(
      PRODUCT_WHERE,
      `WHERE p."id" = ANY($1::text[]) AND p."manageStock" = true`,
    ),
    variant: variant.replace(
      VARIANT_WHERE,
      `WHERE v."id" = ANY($1::text[]) AND v."manageStock" IS TRUE`,
    ),
  };
}

async function withProduct(
  tx: TestTx,
  options: {
    manageStock: boolean;
    variants: Array<{ manageStock: boolean | null; stocked: boolean }>;
  },
) {
  const warehouse = await tx.warehouse.create({
    data: { code: `w_${uid()}`, name: "Depozit de test" },
  });
  const product = await tx.product.create({
    data: { slug: `p-${uid()}`, title: "Produs", manageStock: options.manageStock },
  });
  const variants = [];
  for (const spec of options.variants) {
    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        sku: `SKU-${uid()}`,
        price: 1000,
        manageStock: spec.manageStock,
      },
    });
    if (spec.stocked) {
      await tx.inventoryItem.create({
        data: { variantId: variant.id, warehouseId: warehouse.id, physical: 10_000n },
      });
    }
    variants.push(variant);
  }
  return { product, variants };
}

describe("migrarea de date D2: produsele și variantele existente fără stoc trec pe «negestionat»", () => {
  it("instrucțiunile migrației au forma așteptată și nu schimbă `updatedAt`", () => {
    const { product, variant } = dataMigration();
    expect(product).not.toMatch(/updatedAt/);
    expect(variant).not.toMatch(/updatedAt/);
  });

  it("produs gestionat fără niciun rând de stoc → negestionat; cu stoc pe cel puțin o variantă → rămâne gestionat", async () => {
    const m = dataMigration();
    await inRolledBackTransaction(db, async (tx) => {
      const empty = await withProduct(tx, {
        manageStock: true,
        variants: [{ manageStock: null, stocked: false }],
      });
      const stocked = await withProduct(tx, {
        manageStock: true,
        variants: [{ manageStock: null, stocked: true }],
      });
      const mixed = await withProduct(tx, {
        manageStock: true,
        variants: [
          { manageStock: null, stocked: false },
          { manageStock: null, stocked: true },
        ],
      });
      const already = await withProduct(tx, {
        manageStock: false,
        variants: [{ manageStock: null, stocked: false }],
      });
      const ids = [empty, stocked, mixed, already].map((p) => p.product.id);
      const before = await tx.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, updatedAt: true },
      });

      await tx.$executeRawUnsafe(m.product, ids);

      const after = await tx.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, manageStock: true, updatedAt: true },
      });
      const flag = (id: string) => after.find((p) => p.id === id)?.manageStock;
      expect(flag(empty.product.id), "fără stoc nicăieri").toBe(false);
      expect(flag(stocked.product.id), "cu stoc").toBe(true);
      expect(flag(mixed.product.id), "o variantă cu stoc ajunge: produsul rămâne gestionat").toBe(
        true,
      );
      expect(flag(already.product.id), "deja negestionat").toBe(false);
      for (const p of after) {
        expect(p.updatedAt, "updatedAt neschimbat").toEqual(
          before.find((b) => b.id === p.id)?.updatedAt,
        );
      }
    });
  });

  it("variantă cu bifă proprie «gestionat» fără rând de stoc → negestionată; cu rând → rămâne; fără bifă proprie (moștenește) → nu se atinge", async () => {
    const m = dataMigration();
    await inRolledBackTransaction(db, async (tx) => {
      const p = await withProduct(tx, {
        manageStock: true,
        variants: [
          { manageStock: true, stocked: false },
          { manageStock: true, stocked: true },
          { manageStock: null, stocked: false },
          { manageStock: false, stocked: false },
        ],
      });
      const ids = p.variants.map((v) => v.id);
      const before = await tx.productVariant.findMany({
        where: { id: { in: ids } },
        select: { id: true, updatedAt: true },
      });

      await tx.$executeRawUnsafe(m.variant, ids);

      const after = await tx.productVariant.findMany({
        where: { id: { in: ids } },
        select: { id: true, manageStock: true, updatedAt: true },
      });
      const flag = (index: number) =>
        after.find((v) => v.id === p.variants[index]!.id)?.manageStock;
      expect(flag(0), "bifă proprie, fără stoc").toBe(false);
      expect(flag(1), "bifă proprie, cu stoc").toBe(true);
      expect(flag(2), "moștenește: rămâne nul").toBeNull();
      expect(flag(3), "deja negestionată").toBe(false);
      for (const v of after) {
        expect(v.updatedAt, "updatedAt neschimbat").toEqual(
          before.find((b) => b.id === v.id)?.updatedAt,
        );
      }
    });
  });
});
