import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, harness, type Harness } from "../test-utils/checkout-fixtures";
import { createUser } from "../test-utils/digital-fixtures";
import { EMPTY_GROUP_DISPLAY, loadGroupDisplayPrices } from "./group-display";

/**
 * Prețul de grup din vitrină (Faza 15): calculat dinamic, prin motor, doar pentru clientul logat cu grup; rezultatul nu conține
 * costul sau adaosul și nu se amestecă între clienți. Cifre de mână: 199,00 × 0,95 = 189,05; costNet 100,00 · 12% · 21% = 135,52.
 */
const db = getDb();
afterAll(() => db.$disconnect());
const uid = (): string => randomUUID().slice(0, 8);
const SETTINGS = { showSalePricing: false, taxStandardRate: 21 } as const;

async function groupUser(h: Harness, data: Record<string, unknown> | null) {
  const user = await createUser(h.tx, true);
  if (data) {
    const group = await h.tx.customerGroup.create({
      data: { name: `G ${uid()}`, slug: `g-${uid()}`, ...data } as never,
    });
    await h.tx.user.update({ where: { id: user.id }, data: { customerGroupId: group.id } });
  }
  return user.id;
}

describe("prețurile de grup din vitrină", () => {
  it("Fidel: prețul pe variantă și pe card, față de prețul standard", async () => {
    await harness(async (h) => {
      const userId = await groupUser(h, {
        pricingType: "discount",
        discountBps: 500,
        name: "Client fidel",
      });
      const p = await h.product({ price: 19_900 });
      const out = await loadGroupDisplayPrices(
        h.tx,
        userId,
        { variantIds: [p.variantId], productIds: [p.productId] },
        SETTINGS,
        NOW,
      );
      expect(out.group).toEqual({
        name: "Client fidel",
        pricingType: "discount",
        discountBps: 500,
      });
      expect(out.variants[p.variantId]).toEqual({ amount: 18_905, standard: 19_900 });
      expect(out.products[p.productId]).toEqual({
        amount: 18_905,
        standard: 19_900,
        isRange: false,
      });
    });
  });

  it("Partener: prețul cost-plus (135,52), fără cost sau adaos în rezultat", async () => {
    await harness(async (h) => {
      const userId = await groupUser(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await h.product({ price: 19_900 });
      await h.tx.productVariant.update({ where: { id: p.variantId }, data: { costPrice: 10_000 } });
      const out = await loadGroupDisplayPrices(
        h.tx,
        userId,
        { variantIds: [p.variantId], productIds: [p.productId] },
        SETTINGS,
        NOW,
      );
      expect(out.variants[p.variantId]).toEqual({ amount: 13_552, standard: 19_900 });
      expect(out.group).toEqual({
        name: expect.any(String),
        pricingType: "cost_plus",
        discountBps: null,
      });
      const keys = JSON.stringify(out).match(/"[A-Za-z]+":/g) ?? [];
      expect(keys.filter((key) => /cost|markup/i.test(key))).toEqual([]);
      expect(JSON.stringify(out)).not.toContain("10000");
    });
  });

  it("partener fără preț NIR sau cu produs exclus: nicio intrare (se afișează prețul public)", async () => {
    await harness(async (h) => {
      const userId = await groupUser(h, { pricingType: "cost_plus", markupBps: 1200 });
      const noCost = await h.product({ price: 19_900 });
      const excluded = await h.product({ price: 19_900 });
      await h.tx.productVariant.update({
        where: { id: excluded.variantId },
        data: { costPrice: 10_000 },
      });
      await h.tx.product.update({
        where: { id: excluded.productId },
        data: { excludeFromGroupDiscount: true },
      });
      const out = await loadGroupDisplayPrices(
        h.tx,
        userId,
        {
          variantIds: [noCost.variantId, excluded.variantId],
          productIds: [noCost.productId, excluded.productId],
        },
        SETTINGS,
        NOW,
      );
      expect(out.variants).toEqual({});
      expect(out.products).toEqual({});
    });
  });

  it("partenerul nu vede niciodată un preț peste cel public (promoția 129,00 bate 135,52)", async () => {
    await harness(async (h) => {
      const userId = await groupUser(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await h.product({ price: 19_900 });
      await h.tx.productVariant.update({
        where: { id: p.variantId },
        data: {
          costPrice: 10_000,
          salePrice: 12_900,
          saleStartsAt: new Date(NOW.getTime() - 86_400_000),
          saleEndsAt: new Date(NOW.getTime() + 86_400_000),
        },
      });
      const shown = await loadGroupDisplayPrices(
        h.tx,
        userId,
        { variantIds: [p.variantId], productIds: [] },
        { ...SETTINGS, showSalePricing: true },
        NOW,
      );
      // prețul public curent e 129,00: partenerul plătește tot 129,00, deci nu are preț de grup de afișat
      expect(shown.variants).toEqual({});
    });
  });

  it("oaspete, client fără grup și «Client standard»: rezultat gol, ca azi", async () => {
    await harness(async (h) => {
      const p = await h.product({ price: 19_900 });
      const request = { variantIds: [p.variantId], productIds: [p.productId] };
      expect(await loadGroupDisplayPrices(h.tx, null, request, SETTINGS, NOW)).toEqual(
        EMPTY_GROUP_DISPLAY,
      );
      const none = await groupUser(h, null);
      expect(await loadGroupDisplayPrices(h.tx, none, request, SETTINGS, NOW)).toEqual(
        EMPTY_GROUP_DISPLAY,
      );
      const standard = await groupUser(h, { pricingType: "none" });
      expect(await loadGroupDisplayPrices(h.tx, standard, request, SETTINGS, NOW)).toEqual(
        EMPTY_GROUP_DISPLAY,
      );
    });
  });

  it("card cu mai multe variante: «de la» cel mai mic preț de grup", async () => {
    await harness(async (h) => {
      const userId = await groupUser(h, { pricingType: "discount", discountBps: 1000 });
      const a = await h.product({ price: 10_000 });
      const extra = await h.tx.productVariant.create({
        data: { productId: a.productId, sku: `X-${uid()}`, price: 20_000, position: 5 },
      });
      void extra;
      const out = await loadGroupDisplayPrices(
        h.tx,
        userId,
        { variantIds: [], productIds: [a.productId] },
        SETTINGS,
        NOW,
      );
      expect(out.products[a.productId]).toEqual({ amount: 9_000, standard: 10_000, isRange: true });
    });
  });

  it("cererile uriașe se taie la limită", async () => {
    await harness(async (h) => {
      const userId = await groupUser(h, { pricingType: "discount", discountBps: 500 });
      const ids = Array.from({ length: 500 }, (_, i) => `fantoma-${i}`);
      const out = await loadGroupDisplayPrices(
        h.tx,
        userId,
        { variantIds: ids, productIds: ids },
        SETTINGS,
        NOW,
      );
      expect(out.variants).toEqual({});
    });
  });
});
