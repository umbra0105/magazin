import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  COST_PRICE_SOURCES,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  SHIPPING_CLASSES,
  STOCK_STATUSES,
} from "./constants";

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function newBrand(tx: TestTx) {
  return tx.brand.create({ data: { slug: `brand-${uid()}`, name: "Brand de test" } });
}

async function newProduct(tx: TestTx, over: Record<string, unknown> = {}) {
  const brand = await newBrand(tx);
  return tx.product.create({
    data: { slug: `produs-${uid()}`, title: "Produs de test", brandId: brand.id, ...over },
  });
}

async function newVariant(tx: TestTx, productId: string, over: Record<string, unknown> = {}) {
  return tx.productVariant.create({
    data: { productId, sku: `SKU-${uid()}`, price: 19900, ...over },
  });
}

async function newMedia(tx: TestTx) {
  const id = uid();
  return tx.media.create({
    data: {
      mime: "image/jpeg",
      sizeBytes: 10,
      checksum: id,
      originalName: `${id}.jpg`,
      storageKey: `public/test/${id}/original`,
    },
  });
}

/** Rulează `fn` într-o tranzacție anulată și cere ca ea să fie respinsă de bază (constrângere). */
async function violation(fn: (tx: TestTx) => Promise<unknown>, constraint?: string): Promise<void> {
  const error = await inRolledBackTransaction(db, async (tx) => {
    try {
      await fn(tx);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
  expect(error, "baza trebuia să respingă scrierea").not.toBeNull();
  if (constraint) expect(JSON.stringify(error) + String(error?.message)).toContain(constraint);
}

describe("catalog: valori implicite și enum-uri", () => {
  it("un produs nou: draft, physical, standard, manageStock activ, instock", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      expect(p).toMatchObject({
        status: "draft",
        type: "physical",
        shippingClass: "standard",
        manageStock: true,
        stockStatus: "instock",
        requiresInstallation: false,
        excludeFromGroupDiscount: false,
        deletedAt: null,
        legacyId: null,
      });
    });
  });

  it("toate valorile din constantele @ecom/core sunt acceptate de CHECK-urile din bază", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      for (const status of PRODUCT_STATUSES) await newProduct(tx, { status });
      for (const type of PRODUCT_TYPES) await newProduct(tx, { type });
      for (const shippingClass of SHIPPING_CLASSES) await newProduct(tx, { shippingClass });
      for (const stockStatus of STOCK_STATUSES) {
        const p = await newProduct(tx, { stockStatus });
        await newVariant(tx, p.id, { stockStatus });
      }
      const variant = await newVariant(tx, (await newProduct(tx)).id);
      for (const source of COST_PRICE_SOURCES) {
        await tx.costPriceHistory.create({
          data: { variantId: variant.id, costPrice: 1000, effectiveDate: new Date(), source },
        });
      }
    });
  });

  it("shippingClass admite exact standard, oversized, pallet", async () => {
    expect([...SHIPPING_CLASSES]).toEqual(["standard", "oversized", "pallet"]);
    await violation((tx) => newProduct(tx, { shippingClass: "freight" }), "shippingClass_check");
    await violation((tx) => newProduct(tx, { shippingClass: "Pallet" }), "shippingClass_check");
  });

  it("refuză status, tip și stockStatus necunoscute", async () => {
    await violation((tx) => newProduct(tx, { status: "published" }), "status_check");
    await violation((tx) => newProduct(tx, { type: "service" }), "type_check");
    await violation((tx) => newProduct(tx, { stockStatus: "lowstock" }), "stockStatus_check");
  });
});

describe("catalog: variante și sume", () => {
  it("refuză sume negative, promoție peste preț, fereastră de promoție inversă, EAN invalid, dimensiuni nule", async () => {
    await violation(async (tx) => newVariant(tx, (await newProduct(tx)).id, { price: -1 }));
    await violation(async (tx) =>
      newVariant(tx, (await newProduct(tx)).id, { price: 10000, salePrice: 10001 }),
    );
    await violation(async (tx) =>
      newVariant(tx, (await newProduct(tx)).id, {
        saleStartsAt: new Date("2026-10-10"),
        saleEndsAt: new Date("2026-10-01"),
      }),
    );
    await violation(async (tx) => newVariant(tx, (await newProduct(tx)).id, { ean: "12345" }));
    await violation(async (tx) =>
      newVariant(tx, (await newProduct(tx)).id, { ean: "59012345678AB" }),
    );
    await violation(async (tx) => newVariant(tx, (await newProduct(tx)).id, { weightGrams: 0 }));
    await violation(async (tx) => newVariant(tx, (await newProduct(tx)).id, { costPrice: -5 }));
    await violation(async (tx) =>
      newVariant(tx, (await newProduct(tx)).id, { warrantyMonths: -1 }),
    );
  });

  it("acceptă o variantă completă (preț brut, promoție, cost net, EAN-13, greutate, dimensiuni)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      const v = await newVariant(tx, p.id, {
        price: 19900,
        salePrice: 17900,
        saleStartsAt: new Date("2026-10-01"),
        saleEndsAt: new Date("2026-10-31"),
        costPrice: 12000,
        costPriceDate: new Date("2026-09-20"),
        ean: "5901234123457",
        warrantyMonths: 24,
        weightGrams: 60_000,
        lengthMm: 1200,
        widthMm: 500,
        heightMm: 600,
      });
      expect(v.price).toBe(19900);
      expect(v.costPrice).toBe(12000);
    });
  });

  it("SKU-ul e unic; cel mult o variantă implicită per produs", async () => {
    await violation(async (tx) => {
      const p = await newProduct(tx);
      await newVariant(tx, p.id, { sku: "DUP-1" });
      await newVariant(tx, p.id, { sku: "DUP-1" });
    });
    await violation(async (tx) => {
      const p = await newProduct(tx);
      await newVariant(tx, p.id, { isDefault: true });
      await newVariant(tx, p.id, { isDefault: true });
    }, "product_variant_default_key");
  });
});

describe("catalog: slug-uri, branduri, categorii, legacy", () => {
  it("slug-ul produsului e unic pe TOATE produsele (fără diferență de majuscule), inclusiv cele șterse", async () => {
    await violation(async (tx) => {
      const brand = await newBrand(tx);
      await tx.product.create({ data: { slug: "pompa-x", title: "A", brandId: brand.id } });
      await tx.product.create({ data: { slug: "POMPA-X", title: "B", brandId: brand.id } });
    }, "product_slug_key");

    // un produs șters (soft delete) își păstrează adresa: nu se refolosește
    await violation(async (tx) => {
      const brand = await newBrand(tx);
      const first = await tx.product.create({
        data: { slug: "pompa-y", title: "A", brandId: brand.id },
      });
      await tx.product.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
      await tx.product.create({ data: { slug: "pompa-y", title: "B", brandId: brand.id } });
    }, "product_slug_key");
  });

  it("brandul e opțional (produs fără brand), dar un brand inexistent e refuzat și nu se șterge cât are produse", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await tx.product.create({ data: { slug: `p-${uid()}`, title: "Fără brand" } });
      expect(p.brandId).toBeNull();
    });
    await violation((tx) =>
      tx.product.create({
        data: { slug: `p-${uid()}`, title: "Brand inexistent", brandId: "inexistent" },
      }),
    );
    await violation(async (tx) => {
      const brand = await newBrand(tx);
      await tx.product.create({
        data: { slug: `p-${uid()}`, title: "Cu brand", brandId: brand.id },
      });
      await tx.brand.delete({ where: { id: brand.id } });
    });
  });

  it("categoria: slug unic în același părinte (și în rădăcină), același slug permis sub alt părinte", async () => {
    await violation(async (tx) => {
      await tx.category.create({ data: { slug: "pompe", name: "Pompe", path: `pompe-${uid()}` } });
      await tx.category.create({
        data: { slug: "pompe", name: "Pompe 2", path: `pompe-${uid()}` },
      });
    }, "category_slug_in_root_key");

    await violation(async (tx) => {
      const parent = await tx.category.create({
        data: { slug: `p-${uid()}`, name: "P", path: `p-${uid()}` },
      });
      await tx.category.create({
        data: { slug: "filtre", name: "F", path: `${parent.path}/filtre`, parentId: parent.id },
      });
      await tx.category.create({
        data: { slug: "FILTRE", name: "F2", path: `${parent.path}/filtre-2`, parentId: parent.id },
      });
    }, "category_slug_in_parent_key");

    await inRolledBackTransaction(db, async (tx) => {
      const a = await tx.category.create({
        data: { slug: `a-${uid()}`, name: "A", path: `a-${uid()}` },
      });
      const b = await tx.category.create({
        data: { slug: `b-${uid()}`, name: "B", path: `b-${uid()}` },
      });
      await tx.category.create({
        data: { slug: "filtre", name: "F", path: `${a.path}/filtre`, parentId: a.id },
      });
      await tx.category.create({
        data: { slug: "filtre", name: "F", path: `${b.path}/filtre`, parentId: b.id },
      });
    });
  });

  it("o singură categorie primară per produs", async () => {
    await violation(async (tx) => {
      const p = await newProduct(tx);
      const c1 = await tx.category.create({
        data: { slug: `c-${uid()}`, name: "C1", path: `c-${uid()}` },
      });
      const c2 = await tx.category.create({
        data: { slug: `c-${uid()}`, name: "C2", path: `c-${uid()}` },
      });
      await tx.productCategory.create({
        data: { productId: p.id, categoryId: c1.id, isPrimary: true },
      });
      await tx.productCategory.create({
        data: { productId: p.id, categoryId: c2.id, isPrimary: true },
      });
    }, "product_category_primary_key");
  });

  it("legacyId e unic pe produse, categorii și branduri; mai multe NULL sunt permise", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await newProduct(tx);
      await newProduct(tx); // două produse fără legacyId
    });
    await violation(async (tx) => {
      await newProduct(tx, { legacyId: "wc-123", legacyUrl: "https://vechi.test/p/123" });
      await newProduct(tx, { legacyId: "wc-123" });
    });
    await violation(async (tx) => {
      await tx.brand.create({ data: { slug: `b-${uid()}`, name: "B", legacyId: "wc-b-1" } });
      await tx.brand.create({ data: { slug: `b-${uid()}`, name: "B2", legacyId: "wc-b-1" } });
    });
    await violation(async (tx) => {
      await tx.category.create({
        data: { slug: `c-${uid()}`, name: "C", path: `c-${uid()}`, legacyId: "wc-c-1" },
      });
      await tx.category.create({
        data: { slug: `c-${uid()}`, name: "C2", path: `c-${uid()}`, legacyId: "wc-c-1" },
      });
    });
  });
});

describe("catalog: media pe produs și istorice", () => {
  it("atașează media la produs și la o variantă a aceluiași produs; nu de două ori", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      const v = await newVariant(tx, p.id);
      const m = await newMedia(tx);
      await tx.productMedia.create({ data: { productId: p.id, mediaId: m.id } });
      await tx.productMedia.create({ data: { productId: p.id, variantId: v.id, mediaId: m.id } });
    });
    await violation(async (tx) => {
      const p = await newProduct(tx);
      const m = await newMedia(tx);
      await tx.productMedia.create({ data: { productId: p.id, mediaId: m.id } });
      await tx.productMedia.create({ data: { productId: p.id, mediaId: m.id, position: 1 } });
    }, "product_media_product_level_key");
  });

  it("varianta trebuie să aparțină aceluiași produs", async () => {
    await violation(async (tx) => {
      const p1 = await newProduct(tx);
      const p2 = await newProduct(tx);
      const v2 = await newVariant(tx, p2.id);
      const m = await newMedia(tx);
      await tx.productMedia.create({ data: { productId: p1.id, variantId: v2.id, mediaId: m.id } });
    }, "product_media_variantId_productId_fkey");
  });

  it("un fișier folosit de un produs nu se poate șterge din bază (plasa de siguranță sub provider)", async () => {
    await violation(async (tx) => {
      const p = await newProduct(tx);
      const m = await newMedia(tx);
      await tx.productMedia.create({ data: { productId: p.id, mediaId: m.id } });
      await tx.media.delete({ where: { id: m.id } });
    }, "product_media_mediaId_fkey");
  });

  it("ștergerea produsului șterge variantele, legăturile media și istoricele", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const p = await newProduct(tx);
      const v = await newVariant(tx, p.id);
      const m = await newMedia(tx);
      await tx.productMedia.create({ data: { productId: p.id, variantId: v.id, mediaId: m.id } });
      await tx.costPriceHistory.create({
        data: { variantId: v.id, costPrice: 1, effectiveDate: new Date(), source: "manual" },
      });
      await tx.priceHistory.create({
        data: { variantId: v.id, price: 19900, effectiveFrom: new Date() },
      });
      await tx.product.delete({ where: { id: p.id } });
      expect(await tx.productVariant.count({ where: { id: v.id } })).toBe(0);
      expect(await tx.productMedia.count({ where: { productId: p.id } })).toBe(0);
      expect(await tx.costPriceHistory.count({ where: { variantId: v.id } })).toBe(0);
      expect(await tx.priceHistory.count({ where: { variantId: v.id } })).toBe(0);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(1);
    });
  });

  it("istoricul de preț: un singur punct per variantă și moment; preț nenegativ", async () => {
    await violation(async (tx) => {
      const v = await newVariant(tx, (await newProduct(tx)).id);
      const at = new Date("2026-10-01T00:00:00Z");
      await tx.priceHistory.create({ data: { variantId: v.id, price: 1, effectiveFrom: at } });
      await tx.priceHistory.create({ data: { variantId: v.id, price: 2, effectiveFrom: at } });
    });
    await violation(async (tx) => {
      const v = await newVariant(tx, (await newProduct(tx)).id);
      await tx.priceHistory.create({
        data: { variantId: v.id, price: -1, effectiveFrom: new Date() },
      });
    }, "price_history_price_check");
  });
});

describe("catalog: constrângeri completate la închiderea fazei (acoperire)", () => {
  const category = (tx: TestTx, depth: number) =>
    tx.category.create({
      data: { name: `Adâncime ${depth}`, slug: `adm-${uid()}`, path: `adm-${uid()}`, depth },
    });

  it("adâncimea categoriei: între 0 și 10 în bază (serviciul limitează la 4)", async () => {
    await violation((tx) => category(tx, -1), "category_depth_check");
    await violation((tx) => category(tx, 11), "category_depth_max_check");
    await inRolledBackTransaction(db, async (tx) => {
      expect((await category(tx, 0)).depth).toBe(0);
      expect((await category(tx, 10)).depth).toBe(10);
    });
  });

  it("istoricul prețului de achiziție: sumă nenegativă și sursă din lista permisă", async () => {
    const entry = async (tx: TestTx, data: { costPrice: number; source: string }) => {
      const variant = await newVariant(tx, (await newProduct(tx)).id);
      return tx.costPriceHistory.create({
        data: { variantId: variant.id, effectiveDate: new Date(), ...data },
      });
    };
    await violation(
      (tx) => entry(tx, { costPrice: -1, source: "manual" }),
      "cost_price_history_costPrice_check",
    );
    await violation(
      (tx) => entry(tx, { costPrice: 100, source: "nimic" }),
      "cost_price_history_source_check",
    );
    await inRolledBackTransaction(db, async (tx) => {
      expect((await entry(tx, { costPrice: 0, source: "import" })).costPrice).toBe(0);
    });
  });

  it("codul clasei de taxare: litere mici, cifre și «_», începe cu literă", async () => {
    for (const bad of ["Redusa", "1redusa", "redusă", "red usa", ""]) {
      await violation(
        (tx) => tx.taxClass.create({ data: { code: bad, name: "X" } }),
        "tax_class_code_check",
      );
    }
    await inRolledBackTransaction(db, async (tx) => {
      expect(
        (await tx.taxClass.create({ data: { code: `redusa_${uid()}`.slice(0, 20), name: "X" } }))
          .name,
      ).toBe("X");
    });
  });
});
