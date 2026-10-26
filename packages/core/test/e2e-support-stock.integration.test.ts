import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
} from "../src/test-utils/stock-fixtures";
import {
  createE2eRole,
  readE2eStock,
  removeE2eStock,
  removeE2eStockShared,
  seedE2eStock,
  seedE2eUnit,
  setE2eStockSnapshot,
} from "./e2e-support";

/**
 * Curățarea E2E de stoc (`removeE2eStock`) oprește TEMPORAR triggerul de imuabilitate al registrului de mișcări. Excepția din
 * `append-only.test.ts` e aprobată doar cu aceste garanții, dovedite aici pe Postgres real (date comise, fișier separat):
 *  1. funcțiile refuză orice bază fără «test» ca segment în nume, ÎNAINTE de orice interogare;
 *  2. șterg DOAR ce e al testelor E2E (variante `E2ESTOC…`); orice altă mișcare rămâne neatinsă;
 *  3. la orice eșec tranzacția se anulează, iar triggerul rămâne ACTIV.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const tag = () => Math.random().toString(16).slice(2, 8);

/** Depozitul implicit există (seed) sau se creează unul temporar, scos la final (testul nu presupune seed). */
let restoreDefaultWarehouse: () => Promise<void> = async () => undefined;
let defaultWarehouseId = "";

beforeAll(async () => {
  const existing = await db.warehouse.findFirst({ where: { isDefault: true } });
  if (existing) {
    defaultWarehouseId = existing.id;
    return;
  }
  const created = await db.warehouse.create({
    data: { code: `w_e2e${tag()}`, name: "Implicit temporar", isDefault: true },
  });
  defaultWarehouseId = created.id;
  restoreDefaultWarehouse = async () => {
    await db.warehouse.update({ where: { id: created.id }, data: { isDefault: false } });
    await db.warehouse.delete({ where: { id: created.id } });
  };
});

afterAll(async () => {
  await removeE2eStock().catch(() => undefined);
  await restoreDefaultWarehouse();
});

const movement = (variantId: string, warehouseId: string, note: string) =>
  db.stockMovement.create({
    data: {
      variantId,
      warehouseId,
      kind: "adjustment",
      reason: "other",
      note,
      deltaPhysical: 10_000n,
      physicalAfter: 60_000n,
      committedAfter: 0n,
      effectiveAt: new Date(),
    },
  });

async function expectTriggerActive(variantId: string): Promise<void> {
  // registrul e imuabil: o modificare trebuie respinsă de bază
  await expect(
    db.stockMovement.updateMany({ where: { variantId }, data: { note: "rescris" } }),
  ).rejects.toThrow();
}

describe("gărzile: refuz pe orice bază fără «test» ca segment, înainte de orice interogare", () => {
  it.each(["ecom", "ecom_dev", "ecom_prod", "contest", "latest_orders"])(
    "baza «%s»: removeE2eStock, seedE2eStock și setE2eStockSnapshot refuză",
    async (name) => {
      const original = process.env["TEST_DATABASE_URL"];
      // portul 1 nu ascultă nimeni: dacă garda n-ar fi prima, eroarea ar fi de conexiune, nu «REFUZ»
      process.env["TEST_DATABASE_URL"] = `postgresql://u:p@127.0.0.1:1/${name}`;
      try {
        await expect(removeE2eStock()).rejects.toThrow(/REFUZ/);
        await expect(seedE2eStock("x", [])).rejects.toThrow(/REFUZ/);
        await expect(setE2eStockSnapshot(null)).rejects.toThrow(/REFUZ/);
      } finally {
        if (original === undefined) delete process.env["TEST_DATABASE_URL"];
        else process.env["TEST_DATABASE_URL"] = original;
      }
    },
  );
});

describe("curățarea E2E de stoc: restricția pe variantele E2ESTOC…", () => {
  it("șterge mișcările și produsele E2E, lasă neatinse mișcările altor variante, iar triggerul rămâne activ", async () => {
    const [sku] = await seedE2eStock(tag(), [
      {
        title: "Produs E2E de curățat",
        brand: { name: "Brand E2E de curățat", defaultLeadTimeDays: 5 },
        leadTimeDays: 2,
        saleStepLabel: "sac",
        variants: [{ sku: "A", physical: "5" }],
      },
    ]);
    expect(sku?.startsWith("E2ESTOC")).toBe(true);
    const e2e = await readE2eStock(sku as string);
    const e2eVariantId = e2e?.variantId as string;
    await movement(e2eVariantId, defaultWarehouseId, "mișcare E2E");

    // un brand care NU e al testelor E2E (adresa fără prefixul `e2e-stoc-`): curățarea nu-l atinge
    const foreignBrand = await db.brand.create({
      data: { slug: `strain-${tag()}`, name: "Brand străin", defaultLeadTimeDays: 7 },
    });
    expect(
      await db.brand.count({ where: { slug: { startsWith: "e2e-stoc-" } } }),
    ).toBeGreaterThanOrEqual(1);

    // o variantă care NU e a testelor E2E, cu propria mișcare
    const ctx = await createStockContext(db);
    try {
      const other = await addStockProduct(db, ctx, { variants: [{ physical: "3" }] });
      const otherVariantId = other.variants[0]!.id;
      await movement(otherVariantId, ctx.warehouseId, "mișcare străină");

      const removed = await removeE2eStock();
      expect(removed).toBeGreaterThanOrEqual(1);

      // ce era E2E a dispărut cu totul
      expect(await db.stockMovement.count({ where: { variantId: e2eVariantId } })).toBe(0);
      expect(await db.productVariant.count({ where: { id: e2eVariantId } })).toBe(0);
      expect(await readE2eStock(sku as string)).toBeNull();
      // brandul E2E a dispărut, cel străin a rămas
      expect(await db.brand.count({ where: { slug: { startsWith: "e2e-stoc-" } } })).toBe(0);
      expect(await db.brand.count({ where: { id: foreignBrand.id } })).toBe(1);
      // ce nu era E2E a rămas întreg
      expect(await db.stockMovement.count({ where: { variantId: otherVariantId } })).toBe(1);
      expect(await db.productVariant.count({ where: { id: otherVariantId } })).toBe(1);
      expect(await db.inventoryItem.count({ where: { variantId: otherVariantId } })).toBe(1);
      await expectTriggerActive(otherVariantId);
    } finally {
      await purgeStockContext(db, ctx);
      await db.brand.deleteMany({ where: { id: foreignBrand.id } });
    }
  });

  it("o variantă cu nume greșit sub un produs «e2e-stoc-…» nu e ștearsă pe furiș: curățarea eșuează ZGOMOTOS, se anulează cu totul, iar triggerul rămâne activ", async () => {
    const ctx = await createStockContext(db);
    try {
      const product = await addStockProduct(db, ctx, { variants: [{ physical: "3" }] });
      const variantId = product.variants[0]!.id;
      // produs cu adresa E2E, dar varianta (SKU) nu e E2ESTOC…: mișcarea ei NU trebuie ștearsă
      await db.product.update({
        where: { id: product.productId },
        data: { slug: `e2e-stoc-gresit-${tag()}` },
      });
      await movement(variantId, ctx.warehouseId, "nu e a E2E");

      await expect(removeE2eStock()).rejects.toThrow();
      expect(await db.stockMovement.count({ where: { variantId } })).toBe(1);
      expect(await db.productVariant.count({ where: { id: variantId } })).toBe(1);
      await expectTriggerActive(variantId);
    } finally {
      await purgeStockContext(db, ctx);
    }
  });

  it("rulată de două ori, a doua nu face nimic și nu dă eroare", async () => {
    await seedE2eStock(tag(), [{ title: "Produs E2E", variants: [{ sku: "B", physical: "1" }] }]);
    expect(await removeE2eStock()).toBeGreaterThanOrEqual(1);
    expect(await removeE2eStock()).toBe(0);
  });
});

describe("ajutoarele pentru pragul «stoc mic» (punctul 10a)", () => {
  it("seed cu prag propriu pe o variantă, citirea pragului (nul când nu există) și variantele fără rând de stoc", async () => {
    const t = tag();
    try {
      const [own, inherits, neverStocked] = await seedE2eStock(t, [
        {
          title: `Prag ${t}`,
          variants: [
            { sku: "A", physical: "5", lowStockSteps: 4 },
            { sku: "B", physical: "5" },
            { sku: "C", physical: null },
          ],
        },
      ]);
      expect((await readE2eStock(own as string))?.lowStockSteps).toBe(4);
      expect((await readE2eStock(inherits as string))?.lowStockSteps).toBeNull();
      expect((await readE2eStock(neverStocked as string))?.lowStockSteps).toBeNull();
      expect(await readE2eStock("nu-exista")).toBeNull();
    } finally {
      await removeE2eStock({ tag: t });
    }
  });
});

describe("curățarea pe tag: fișierele de teste rulate în paralel nu își șterg produsele între ele", () => {
  it("șterge doar ce are tag-ul dat (produse, mișcări, branduri, unități); ale altui tag rămân cu mișcările lor; rolurile și poza nu se ating", async () => {
    const mine = tag();
    const other = tag();
    const spec = (title: string) => ({
      title,
      unit: { symbol: `u${tag()}`, decimals: 1 },
      brand: { name: `Brand ${title}`, defaultLeadTimeDays: 3 },
      variants: [{ sku: "A", physical: "5" }],
    });
    const [mineSku] = await seedE2eStock(mine, [spec("Produsul meu")]);
    const [otherSku] = await seedE2eStock(other, [spec("Produsul altuia")]);
    const mineVariant = (await readE2eStock(mineSku as string))?.variantId as string;
    const otherVariant = (await readE2eStock(otherSku as string))?.variantId as string;
    await movement(mineVariant, defaultWarehouseId, "mișcare a mea");
    await movement(otherVariant, defaultWarehouseId, "mișcare a altuia");
    // unități fără niciun produs: gărzii «nu e folosită» nu-i mai rămâne de lucru, deci doar tag-ul le separă
    const mineUnit = `e2e${mine}solo`;
    const otherUnit = `e2e${other}solo`;
    await seedE2eUnit({
      code: mineUnit,
      name: `Unitate ${mineUnit}`,
      symbol: `s${mine}`,
      decimals: 0,
    });
    await seedE2eUnit({
      code: otherUnit,
      name: `Unitate ${otherUnit}`,
      symbol: `s${other}`,
      decimals: 0,
    });
    await createE2eRole("e2e-stoc-tag-test", []);
    await setE2eStockSnapshot(2);
    try {
      expect(await removeE2eStock({ tag: mine })).toBe(1);
      expect(await db.measureUnit.count({ where: { code: mineUnit } })).toBe(0);
      expect(await db.measureUnit.count({ where: { code: otherUnit } })).toBe(1);

      // ce era al meu a dispărut, cu mișcări și brand
      expect(await readE2eStock(mineSku as string)).toBeNull();
      expect(await db.stockMovement.count({ where: { variantId: mineVariant } })).toBe(0);
      expect(await db.brand.count({ where: { slug: { startsWith: `e2e-stoc-${mine}-` } } })).toBe(
        0,
      );
      expect(await db.measureUnit.count({ where: { code: { startsWith: `e2e${mine}` } } })).toBe(0);
      // ce era al altuia a rămas întreg, inclusiv mișcarea (și triggerul rămâne activ)
      expect(await readE2eStock(otherSku as string)).not.toBeNull();
      expect(await db.stockMovement.count({ where: { variantId: otherVariant } })).toBe(1);
      expect(await db.brand.count({ where: { slug: { startsWith: `e2e-stoc-${other}-` } } })).toBe(
        1,
      );
      expect(await db.measureUnit.count({ where: { code: { startsWith: `e2e${other}` } } })).toBe(
        2,
      );
      await expectTriggerActive(otherVariant);
      // rolurile și poza sunt comune: curățarea pe tag nu le atinge
      expect(await db.role.count({ where: { key: "e2e-stoc-tag-test" } })).toBe(1);
      expect(
        await db.stockSnapshot.count({ where: { fileName: "e2e-stoc" } }),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await removeE2eStock({ tag: other });
      await removeE2eStockShared();
    }
    expect(await db.role.count({ where: { key: "e2e-stoc-tag-test" } })).toBe(0);
    expect(await db.stockSnapshot.count({ where: { fileName: "e2e-stoc" } })).toBe(0);
  });

  it("un tag care nu e hexazecimal se refuză înainte de orice interogare (nu devine un tipar de ștergere)", async () => {
    for (const bad of ["", "%", "ab%", "a_b", "ZZZ", "x".repeat(40), "a b"]) {
      await expect(removeE2eStock({ tag: bad }), bad).rejects.toThrow(/tag/i);
    }
  });
});
