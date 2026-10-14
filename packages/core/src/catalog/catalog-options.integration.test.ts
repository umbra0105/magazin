import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { ATTRIBUTE_TYPES, COLLECTION_TYPES, PRODUCT_RELATION_TYPES } from "./constants";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

const newProduct = (tx: TestTx, title = "Produs") =>
  tx.product.create({ data: { slug: `p-${uid()}`, title } });

const newVariant = (tx: TestTx, productId: string) =>
  tx.productVariant.create({ data: { productId, sku: `SKU-${uid()}`, price: 1000 } });

const newAttribute = (tx: TestTx, type: string, over: Record<string, unknown> = {}) =>
  tx.attribute.create({ data: { code: `a_${uid()}`, name: "Atribut", type, ...over } });

/** Rulează într-o tranzacție anulată și cere ca baza să respingă scrierea (opțional: după nume). */
async function violation(fn: (tx: TestTx) => Promise<unknown>, expected?: string): Promise<void> {
  const error = await inRolledBackTransaction(db, async (tx) => {
    try {
      await fn(tx);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
  expect(error, "baza trebuia să respingă scrierea").not.toBeNull();
  if (expected) expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

describe("opțiuni de variantă", () => {
  async function setup(tx: TestTx) {
    const product = await newProduct(tx);
    const size = await tx.productOption.create({ data: { productId: product.id, name: "Mărime" } });
    const color = await tx.productOption.create({
      data: { productId: product.id, name: "Culoare" },
    });
    const s = await tx.optionValue.create({ data: { optionId: size.id, value: "S" } });
    const m = await tx.optionValue.create({ data: { optionId: size.id, value: "M" } });
    const red = await tx.optionValue.create({ data: { optionId: color.id, value: "Roșu" } });
    const variant = await newVariant(tx, product.id);
    return { product, size, color, s, m, red, variant };
  }

  it("atribuie o valoare per opțiune unei variante; ștergerea variantei și a produsului curăță legăturile", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const c = await setup(tx);
      for (const [optionId, optionValueId] of [
        [c.size.id, c.s.id],
        [c.color.id, c.red.id],
      ] as const) {
        await tx.variantOptionValue.create({
          data: {
            variantId: c.variant.id,
            productId: c.product.id,
            optionId,
            optionValueId,
          },
        });
      }
      expect(await tx.variantOptionValue.count({ where: { variantId: c.variant.id } })).toBe(2);
      await tx.product.delete({ where: { id: c.product.id } });
      expect(await tx.variantOptionValue.count({ where: { variantId: c.variant.id } })).toBe(0);
      expect(await tx.optionValue.count({ where: { optionId: c.size.id } })).toBe(0);
    });
  });

  it("o variantă nu poate avea două valori pentru aceeași opțiune", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      const base = { variantId: c.variant.id, productId: c.product.id, optionId: c.size.id };
      await tx.variantOptionValue.create({ data: { ...base, optionValueId: c.s.id } });
      await tx.variantOptionValue.create({ data: { ...base, optionValueId: c.m.id } });
    });
  });

  it("valoarea trebuie să aparțină opțiunii indicate", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.variantOptionValue.create({
        data: {
          variantId: c.variant.id,
          productId: c.product.id,
          optionId: c.size.id,
          optionValueId: c.red.id, // „Roșu” e valoare a opțiunii Culoare
        },
      });
    }, "variant_option_value_optionValueId_optionId_fkey");
  });

  it("opțiunea și varianta trebuie să fie ale aceluiași produs", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      const other = await newProduct(tx, "Alt produs");
      const otherVariant = await newVariant(tx, other.id);
      await tx.variantOptionValue.create({
        data: {
          variantId: otherVariant.id,
          productId: other.id,
          optionId: c.size.id, // opțiunea primului produs
          optionValueId: c.s.id,
        },
      });
    }, "variant_option_value_optionId_productId_fkey");
    await violation(async (tx) => {
      const c = await setup(tx);
      const other = await newProduct(tx, "Alt produs");
      const otherVariant = await newVariant(tx, other.id);
      await tx.variantOptionValue.create({
        data: {
          variantId: otherVariant.id,
          productId: c.product.id, // varianta nu aparține acestui produs
          optionId: c.size.id,
          optionValueId: c.s.id,
        },
      });
    }, "variant_option_value_variantId_productId_fkey");
  });

  it("o valoare folosită de o variantă nu se poate șterge direct; numele sunt unice per produs", async () => {
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.variantOptionValue.create({
        data: {
          variantId: c.variant.id,
          productId: c.product.id,
          optionId: c.size.id,
          optionValueId: c.s.id,
        },
      });
      await tx.optionValue.delete({ where: { id: c.s.id } });
    }, "variant_option_value_optionValueId_optionId_fkey");
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.productOption.create({ data: { productId: c.product.id, name: "MĂRIME" } });
    }, "product_option_name_key");
    await violation(async (tx) => {
      const c = await setup(tx);
      await tx.optionValue.create({ data: { optionId: c.size.id, value: "s" } });
    }, "option_value_value_key");
  });
});

describe("colecții", () => {
  it("tipurile permise, slug unic fără diferență de majuscule, produse într-o colecție manuală", async () => {
    expect([...COLLECTION_TYPES]).toEqual(["manual", "automated"]);
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      const c = await tx.collection.create({ data: { slug: `promo-${uid()}`, name: "Promo" } });
      expect(c.type).toBe("manual");
      await tx.collectionProduct.create({ data: { collectionId: c.id, productId: p.id } });
      await tx.collection.create({
        data: { slug: `auto-${uid()}`, name: "Auto", type: "automated", rules: { brand: "x" } },
      });
    });
    await violation(
      (tx) => tx.collection.create({ data: { slug: `c-${uid()}`, name: "C", type: "smart" } }),
      "collection_type_check",
    );
    await violation(async (tx) => {
      await tx.collection.create({ data: { slug: "vara", name: "A" } });
      await tx.collection.create({ data: { slug: "VARA", name: "B" } });
    }, "collection_slug_key");
  });
});

describe("atribute", () => {
  it("tipurile permise coincid cu constanta", async () => {
    expect([...ATTRIBUTE_TYPES]).toEqual(["text", "number", "select", "bool"]);
    for (const type of ATTRIBUTE_TYPES) {
      await inRolledBackTransaction(db, (tx) => newAttribute(tx, type));
    }
    await violation((tx) => newAttribute(tx, "date"), "attribute_type_check");
  });

  it("cod stabil (litere mici, cifre, _) și unic; unitate doar la atributele numerice", async () => {
    await violation(
      (tx) => newAttribute(tx, "number", { code: "Debit-Pompa" }),
      "attribute_code_check",
    );
    await violation(async (tx) => {
      await newAttribute(tx, "text", { code: "culoare" });
      await newAttribute(tx, "text", { code: "culoare" });
    });
    await violation((tx) => newAttribute(tx, "text", { unit: "kW" }), "attribute_unit_check");
    await inRolledBackTransaction(db, async (tx) => {
      const a = await newAttribute(tx, "number", { unit: "m³/h", isFilterable: true });
      expect(a.unit).toBe("m³/h");
    });
  });

  it("valoare numerică exactă (zecimale, nu float) și filtrare pe interval", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const attr = await newAttribute(tx, "number", { unit: "kW", isFilterable: true });
      const values = ["3.5", "7.25", "12", "0.1"];
      for (const v of values) {
        const p = await newProduct(tx);
        await tx.attributeValue.create({
          data: { productId: p.id, attributeId: attr.id, numberValue: v },
        });
      }
      const inRange = await tx.attributeValue.findMany({
        where: { attributeId: attr.id, numberValue: { gte: "3", lte: "8" } },
        orderBy: { numberValue: "asc" },
      });
      expect(inRange.map((r) => r.numberValue?.toString())).toEqual(["3.5", "7.25"]);
      const tiny = await tx.attributeValue.findFirstOrThrow({
        where: { attributeId: attr.id, numberValue: "0.1" },
      });
      expect(tiny.numberValue?.toString()).toBe("0.1"); // 0.1 exact, fără deriva float
    });
  });

  it("exact o valoare setată, potrivită cu tipul atributului", async () => {
    await violation(async (tx) => {
      const a = await newAttribute(tx, "text");
      const p = await newProduct(tx);
      await tx.attributeValue.create({ data: { productId: p.id, attributeId: a.id } });
    }, "attribute_value_type_mismatch");
    await violation(async (tx) => {
      const a = await newAttribute(tx, "text");
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, textValue: "x", boolValue: true },
      });
    }, "attribute_value_one_value_check");
    await violation(async (tx) => {
      const a = await newAttribute(tx, "number", { unit: "kW" });
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, textValue: "mare" },
      });
    }, "attribute_value_type_mismatch");
    await violation(async (tx) => {
      const a = await newAttribute(tx, "bool");
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, numberValue: "1" },
      });
    }, "attribute_value_type_mismatch");
  });

  it("select: opțiunea trebuie să aparțină atributului; o singură valoare per produs și atribut", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await newAttribute(tx, "select");
      const opt = await tx.attributeOption.create({ data: { attributeId: a.id, value: "Sare" } });
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, optionId: opt.id },
      });
    });
    await violation(async (tx) => {
      const a = await newAttribute(tx, "select");
      const other = await newAttribute(tx, "select");
      const foreign = await tx.attributeOption.create({
        data: { attributeId: other.id, value: "Clor" },
      });
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, optionId: foreign.id },
      });
    }, "attribute_value_optionId_attributeId_fkey");
    await violation(async (tx) => {
      const a = await newAttribute(tx, "text");
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, textValue: "A" },
      });
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, textValue: "B" },
      });
    });
  });

  it("un atribut folosit nu se șterge; opțiunile dispar odată cu atributul fără valori", async () => {
    await violation(async (tx) => {
      const a = await newAttribute(tx, "text");
      const p = await newProduct(tx);
      await tx.attributeValue.create({
        data: { productId: p.id, attributeId: a.id, textValue: "A" },
      });
      await tx.attribute.delete({ where: { id: a.id } });
    });
    await inRolledBackTransaction(db, async (tx) => {
      const a = await newAttribute(tx, "select");
      await tx.attributeOption.create({ data: { attributeId: a.id, value: "x" } });
      await tx.attribute.delete({ where: { id: a.id } });
      expect(await tx.attributeOption.count({ where: { attributeId: a.id } })).toBe(0);
    });
  });
});

describe("relații între produse", () => {
  it("acceptă toate cele 6 tipuri; refuză tip necunoscut, auto-relație și dubluri", async () => {
    expect([...PRODUCT_RELATION_TYPES]).toEqual([
      "similar",
      "accessory",
      "upsell",
      "crosssell",
      "spare_part",
      "compatible_with",
    ]);
    await inRolledBackTransaction(db, async (tx) => {
      const a = await newProduct(tx);
      const b = await newProduct(tx);
      for (const type of PRODUCT_RELATION_TYPES) {
        await tx.productRelation.create({
          data: { productId: a.id, relatedProductId: b.id, type },
        });
      }
    });
    await violation(async (tx) => {
      const a = await newProduct(tx);
      const b = await newProduct(tx);
      await tx.productRelation.create({
        data: { productId: a.id, relatedProductId: b.id, type: "bundle" },
      });
    }, "product_relation_type_check");
    await violation(async (tx) => {
      const a = await newProduct(tx);
      await tx.productRelation.create({
        data: { productId: a.id, relatedProductId: a.id, type: "similar" },
      });
    }, "product_relation_self_check");
    await violation(async (tx) => {
      const a = await newProduct(tx);
      const b = await newProduct(tx);
      const data = { productId: a.id, relatedProductId: b.id, type: "spare_part" };
      await tx.productRelation.create({ data });
      await tx.productRelation.create({ data });
    });
  });

  it("relația dispare când se șterge oricare dintre produse", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await newProduct(tx);
      const b = await newProduct(tx);
      await tx.productRelation.create({
        data: { productId: a.id, relatedProductId: b.id, type: "accessory" },
      });
      await tx.product.delete({ where: { id: b.id } });
      expect(await tx.productRelation.count({ where: { productId: a.id } })).toBe(0);
    });
  });
});

describe("clase de taxare (pregătite, nefolosite)", () => {
  it("nu există nicio clasă sau cotă după migrare: nimic hardcodat, cota vine din tax.standardRate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      expect(await tx.taxClass.count()).toBe(0);
      expect(await tx.taxRate.count()).toBe(0);
      const p = await newProduct(tx);
      expect(p.taxClassId).toBeNull();
    });
  });

  it("cota în puncte de bază între 0 și 10000; o singură clasă implicită; clasa folosită nu se șterge", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const c = await tx.taxClass.create({ data: { code: `redusa_${uid()}`, name: "Redusă" } });
      await tx.taxRate.create({ data: { taxClassId: c.id, rateBps: 1100 } });
      await tx.taxRate.create({
        data: { taxClassId: c.id, rateBps: 0, validFrom: new Date("2030-01-01") },
      });
      const p = await tx.product.create({
        data: { slug: `p-${uid()}`, title: "Cu clasă", taxClassId: c.id },
      });
      expect(p.taxClassId).toBe(c.id);
    });
    await violation(async (tx) => {
      const c = await tx.taxClass.create({ data: { code: `c_${uid()}`, name: "C" } });
      await tx.taxRate.create({ data: { taxClassId: c.id, rateBps: 10001 } });
    }, "tax_rate_rateBps_check");
    await violation(async (tx) => {
      const c = await tx.taxClass.create({ data: { code: `c_${uid()}`, name: "C" } });
      await tx.taxRate.create({ data: { taxClassId: c.id, rateBps: -1 } });
    }, "tax_rate_rateBps_check");
    await violation(async (tx) => {
      await tx.taxClass.create({ data: { code: `a_${uid()}`, name: "A", isDefault: true } });
      await tx.taxClass.create({ data: { code: `b_${uid()}`, name: "B", isDefault: true } });
    }, "tax_class_default_key");
    await violation(async (tx) => {
      const c = await tx.taxClass.create({ data: { code: `c_${uid()}`, name: "C" } });
      await tx.product.create({ data: { slug: `p-${uid()}`, title: "P", taxClassId: c.id } });
      await tx.taxClass.delete({ where: { id: c.id } });
    }, "product_taxClassId_fkey");
  });
});
