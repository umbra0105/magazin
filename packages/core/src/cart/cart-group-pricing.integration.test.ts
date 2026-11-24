import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import { createUser } from "../test-utils/digital-fixtures";
import type { CartOwner } from "./cart-service";

/**
 * Prețul de GRUP în coș (Faza 15, docs/09 §3 și §7), pe Postgres real, cu cifre calculate de mână. Fiecare caz are un client cu
 * cont, un grup și un produs; coșul trece prin `CartService` (singurul apelant al motorului de prețuri). Nu presupun seed: grupurile
 * se creează aici, în tranzacția anulată a harness-ului.
 *
 * TVA 21%. Exemple de mână (brut = costNet × (1 + adaos) × 1,21):
 *   costNet 100,00 · adaos 12% → 135,52 lei; costNet 123,45 · adaos 17% → 174,768165 lei;
 *   costNet 99,99 · adaos 12% → 135,506448 lei.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY_MS = 86_400_000;
const uid = (): string => randomUUID().slice(0, 8);

interface GroupSpec {
  name?: string;
  pricingType: "none" | "discount" | "cost_plus";
  discountBps?: number | null;
  markupBps?: number | null;
  stacksWithSalePrice?: boolean;
  earnsLoyaltyPoints?: boolean;
}

async function groupWith(h: Harness, spec: GroupSpec) {
  return h.tx.customerGroup.create({
    data: {
      name: spec.name ?? `Grup ${uid()}`,
      slug: `g-${uid()}`,
      pricingType: spec.pricingType,
      discountBps: spec.discountBps ?? null,
      markupBps: spec.markupBps ?? null,
      stacksWithSalePrice: spec.stacksWithSalePrice ?? false,
      earnsLoyaltyPoints: spec.earnsLoyaltyPoints ?? true,
    },
  });
}

async function buyer(h: Harness, groupId: string | null): Promise<CartOwner & { kind: "user" }> {
  const user = await createUser(h.tx, true);
  if (groupId) {
    await h.tx.user.update({ where: { id: user.id }, data: { customerGroupId: groupId } });
  }
  return { kind: "user", userId: user.id };
}

async function product(
  h: Harness,
  opts: {
    price?: number;
    cost?: number | null;
    sale?: number;
    saleWindow?: "active" | "expired";
    exclude?: boolean;
    step?: string;
  } = {},
) {
  const created = await h.product({
    price: opts.price ?? 19_900,
    ...(opts.step ? { step: opts.step } : {}),
  });
  const data: Record<string, unknown> = {};
  if (opts.cost !== undefined) data["costPrice"] = opts.cost;
  if (opts.sale !== undefined) {
    data["salePrice"] = opts.sale;
    data["saleStartsAt"] = new Date(NOW.getTime() - 3 * DAY_MS);
    data["saleEndsAt"] = new Date(
      NOW.getTime() + (opts.saleWindow === "expired" ? -DAY_MS : DAY_MS),
    );
  }
  if (Object.keys(data).length > 0) {
    await h.tx.productVariant.update({ where: { id: created.variantId }, data });
  }
  if (opts.exclude) {
    await h.tx.product.update({
      where: { id: created.productId },
      data: { excludeFromGroupDiscount: true },
    });
  }
  return created;
}

async function lineOf(h: Harness, owner: CartOwner, variantId: string, quantity?: string) {
  await h.cart.add(owner, { variantId, quantity: quantity ? q(quantity) : "minimum" });
  const view = await h.cart.view(owner);
  const line = view.lines.find((entry) => entry.variantId === variantId);
  if (!line?.pricing) throw new Error("linia nu e prețuită");
  return { view, line, pricing: line.pricing };
}

const SALE_ON = { showSalePricing: true } as const;

describe("Client fidel și VIP (discount)", () => {
  it("Fidel 5%: 199,00 → 189,05; avantajul și eticheta de grup", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, {
        name: "Client fidel",
        pricingType: "discount",
        discountBps: 500,
      });
      const owner = await buyer(h, group.id);
      const p = await product(h);
      const { view, pricing } = await lineOf(h, owner, p.variantId);
      expect(pricing).toMatchObject({
        unitPriceMinor: 18_905,
        totalMinor: 18_905,
        publicLineMinor: 19_900,
        groupAdvantageMinor: 995,
        priceSource: "group_discount",
      });
      expect(view.totals).toMatchObject({ totalMinor: 18_905, groupAdvantageMinor: 995 });
      expect(view.group).toEqual({
        name: "Client fidel",
        pricingType: "discount",
        discountBps: 500,
      });
      expect(view.canCheckout).toBe(true);
    });
  });

  it("VIP 7%: 199,00 → 185,07", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "discount", discountBps: 700 });
      const p = await product(h);
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing.totalMinor).toBe(18_507);
      expect(pricing.groupAdvantageMinor).toBe(1_393);
    });
  });

  it("grup cu 0%: același preț ca la public, fără avantaj", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "discount", discountBps: 0 });
      const p = await product(h);
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing).toMatchObject({ totalMinor: 19_900, groupAdvantageMinor: 0 });
      expect(pricing.priceSource).toBe("public");
    });
  });

  it("promoție: fără cumul se ia cel mai mic preț (promoția 150,00 bate 189,05)", async () => {
    await harness(
      async (h) => {
        const group = await groupWith(h, { pricingType: "discount", discountBps: 500 });
        const p = await product(h, { sale: 15_000 });
        const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
        expect(pricing).toMatchObject({
          totalMinor: 15_000,
          publicLineMinor: 15_000,
          groupAdvantageMinor: 0,
          priceSource: "sale",
        });
      },
      { cart: SALE_ON },
    );
  });

  it("promoție: fără cumul, dacă reducerea de grup e mai mare, se ia ea (promoția 19.000 → 189,05)", async () => {
    await harness(
      async (h) => {
        const group = await groupWith(h, { pricingType: "discount", discountBps: 500 });
        const p = await product(h, { sale: 19_500 });
        const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
        expect(pricing).toMatchObject({ totalMinor: 18_905, priceSource: "group_discount" });
        expect(pricing.publicLineMinor).toBe(19_500);
        expect(pricing.groupAdvantageMinor).toBe(595);
      },
      { cart: SALE_ON },
    );
  });

  it("promoție: cu `stacksWithSalePrice` reducerea se aplică peste promoție (150,00 × 0,95 = 142,50)", async () => {
    await harness(
      async (h) => {
        const group = await groupWith(h, {
          pricingType: "discount",
          discountBps: 500,
          stacksWithSalePrice: true,
        });
        const p = await product(h, { sale: 15_000 });
        const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
        expect(pricing).toMatchObject({
          totalMinor: 14_250,
          publicLineMinor: 15_000,
          groupAdvantageMinor: 750,
          priceSource: "group_discount",
        });
      },
      { cart: SALE_ON },
    );
  });

  it("promoția expirată nu există: prețul de grup pleacă de la prețul de listă", async () => {
    await harness(
      async (h) => {
        const group = await groupWith(h, {
          pricingType: "discount",
          discountBps: 500,
          stacksWithSalePrice: true,
        });
        const p = await product(h, { sale: 15_000, saleWindow: "expired" });
        const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
        expect(pricing.totalMinor).toBe(18_905);
      },
      { cart: SALE_ON },
    );
  });

  it("produs exclus din prețul de grup: toți plătesc prețul public", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "discount", discountBps: 500 });
      const p = await product(h, { exclude: true });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing).toMatchObject({ totalMinor: 19_900, groupAdvantageMinor: 0 });
    });
  });

  it("categorie exclusă din prețul de grup", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "discount", discountBps: 500 });
      const p = await product(h);
      const category = await h.tx.category.create({
        data: {
          name: `Cat ${uid()}`,
          slug: `cat-${uid()}`,
          path: `cat-${uid()}`,
          depth: 0,
          excludeFromGroupDiscount: true,
        },
      });
      await h.tx.productCategory.create({
        data: { productId: p.productId, categoryId: category.id },
      });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing.totalMinor).toBe(19_900);
    });
  });
});

describe("Parteneri (cost_plus)", () => {
  it("formula: costNet 100,00 · adaos 12% · TVA 21% → 135,52 lei, sub prețul public de 199,00", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await product(h, { cost: 10_000 });
      const { view, pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing).toMatchObject({
        unitPriceMinor: 13_552,
        totalMinor: 13_552,
        publicLineMinor: 19_900,
        groupAdvantageMinor: 6_348,
        priceSource: "group_cost_plus",
      });
      expect(view.group).toEqual({
        name: expect.any(String),
        pricingType: "cost_plus",
        discountBps: null,
      });
    });
  });

  it("plafon: dacă prețul de partener ar depăși prețul public, plătește prețul public", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 2100 });
      // 150,00 × 1,21 × 1,21 = 219,615 > 199,00
      const p = await product(h, { cost: 15_000 });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing).toMatchObject({
        totalMinor: 19_900,
        groupAdvantageMinor: 0,
        priceSource: "public",
      });
    });
  });

  it("plafon: exact la prețul public (calculat = public) nu schimbă nimic", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 0 });
      // 164,46 (cost net) × 1,21 = 199,0 (19.899,66): sub 19.900; apoi cu un ban mai mult ajunge la 19.900 sau peste
      const p = await product(h, { cost: 16_446 });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing.totalMinor).toBeLessThanOrEqual(19_900);
      expect(pricing.totalMinor).toBe(19_900); // 16.446 × 1,21 = 19.899,66 → 19.900 (rotunjit pe linie)
      expect(pricing.groupAdvantageMinor).toBe(0);
    });
  });

  it("plafon față de PROMOȚIE: promoția 129,00 bate prețul de partener 135,52", async () => {
    await harness(
      async (h) => {
        const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
        const p = await product(h, { cost: 10_000, sale: 12_900 });
        const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
        expect(pricing).toMatchObject({
          totalMinor: 12_900,
          publicLineMinor: 12_900,
          groupAdvantageMinor: 0,
          priceSource: "sale",
        });
      },
      { cart: SALE_ON },
    );
  });

  it("promoția expirată nu plafonează: partenerul plătește 135,52, nu prețul promoțional vechi", async () => {
    await harness(
      async (h) => {
        const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
        const p = await product(h, { cost: 10_000, sale: 9_000, saleWindow: "expired" });
        const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
        expect(pricing.totalMinor).toBe(13_552);
      },
      { cart: SALE_ON },
    );
  });

  it("fără preț NIR: prețul public, fără avantaj", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await product(h, { cost: null });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing).toMatchObject({ totalMinor: 19_900, groupAdvantageMinor: 0 });
    });
  });

  it("produs exclus: prețul public chiar dacă are preț NIR", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await product(h, { cost: 10_000, exclude: true });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId);
      expect(pricing.totalMinor).toBe(19_900);
    });
  });

  it("rotunjire pe linie, o singură dată: cantitate 7 la costNet 123,45 · 17% → 1.223,38 (nu 7 × 174,77)", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1700 });
      const p = await product(h, { price: 30_000, cost: 12_345 });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId, "7");
      // 12.345 × 1,17 × 1,21 = 17.476,8165 bani pe unitate → × 7 = 122.337,7155 → 122.338
      expect(pricing.unitPriceMinor).toBe(17_477);
      expect(pricing.totalMinor).toBe(122_338);
      expect(pricing.totalMinor).not.toBe(17_477 * 7);
      expect(pricing.publicLineMinor).toBe(210_000);
      expect(pricing.groupAdvantageMinor).toBe(87_662);
      expect(pricing.netMinor + pricing.vatMinor).toBe(pricing.totalMinor);
    });
  });

  it("cantitate zecimală (3,65 la pas de 0,05): 99,99 · 12% → 494,60", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await product(h, { price: 20_000, cost: 9_999, step: "0,05" });
      const { pricing } = await lineOf(h, await buyer(h, group.id), p.variantId, "3,65");
      // 9.999 × 1,12 × 1,21 = 13.550,6448 bani × 3,65 = 49.459,85352 → 49.460
      expect(pricing.totalMinor).toBe(49_460);
      expect(pricing.publicLineMinor).toBe(73_000);
    });
  });

  it("schimbarea prețului NIR (în sus și în jos) mută prețul partenerului la următoarea afișare", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const owner = await buyer(h, group.id);
      const p = await product(h, { cost: 10_000 });
      expect((await lineOf(h, owner, p.variantId)).pricing.totalMinor).toBe(13_552);
      await h.tx.productVariant.update({ where: { id: p.variantId }, data: { costPrice: 11_000 } });
      // 110,00 × 1,12 × 1,21 = 149,0 (14.907,2 bani) → 14.907
      expect((await h.cart.view(owner)).lines[0]?.pricing?.totalMinor).toBe(14_907);
      await h.tx.productVariant.update({ where: { id: p.variantId }, data: { costPrice: 9_000 } });
      expect((await h.cart.view(owner)).lines[0]?.pricing?.totalMinor).toBe(12_197);
    });
  });
});

describe("cine vede ce preț", () => {
  it("doi clienți în grupuri diferite, același produs: fiecare își vede prețul; oaspetele și clientul fără grup, prețul public", async () => {
    await harness(async (h) => {
      const fidel = await groupWith(h, { pricingType: "discount", discountBps: 500 });
      const partner = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const standard = await groupWith(h, { pricingType: "none" });
      const p = await product(h, { cost: 10_000 });
      const totals: Record<string, number> = {};
      for (const [label, owner] of [
        ["fidel", await buyer(h, fidel.id)],
        ["partener", await buyer(h, partner.id)],
        ["standard", await buyer(h, standard.id)],
        ["fără grup", await buyer(h, null)],
      ] as const) {
        totals[label] = (await lineOf(h, owner, p.variantId)).pricing.totalMinor;
      }
      const guest = await h.fill([{ variantId: p.variantId }]);
      totals["oaspete"] = (await h.cart.view(guest)).lines[0]?.pricing?.totalMinor ?? -1;
      expect(totals).toEqual({
        fidel: 18_905,
        partener: 13_552,
        standard: 19_900,
        "fără grup": 19_900,
        oaspete: 19_900,
      });
    });
  });

  it("«Client standard» (none) nu are etichetă de grup în coș", async () => {
    await harness(async (h) => {
      const standard = await groupWith(h, { pricingType: "none" });
      const p = await product(h);
      const { view } = await lineOf(h, await buyer(h, standard.id), p.variantId);
      expect(view.group).toBeNull();
    });
  });

  it("costul și adaosul NU apar nicăieri în ce întoarce coșul (obiectul serializat)", async () => {
    await harness(async (h) => {
      const group = await groupWith(h, { pricingType: "cost_plus", markupBps: 1234 });
      const p = await product(h, { cost: 10_007 });
      const { view } = await lineOf(h, await buyer(h, group.id), p.variantId);
      const keys: string[] = [];
      const numbers: number[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === "number") numbers.push(value);
        if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === "object") {
          for (const [key, inner] of Object.entries(value)) {
            keys.push(key);
            walk(inner);
          }
        }
      };
      walk(view);
      // chei și valori numerice (nu text, unde un id aleatoriu ar putea conține orice)
      expect(keys.filter((key) => /cost|markup/i.test(key))).toEqual([]);
      expect(numbers).not.toContain(10_007);
      expect(numbers).not.toContain(1_234);
    });
  });
});

describe("schimbarea grupului cu coșul deschis", () => {
  it("coșul cere o decizie (prețul s-a schimbat) și nu se modifică în tăcere; după confirmare se poate comanda", async () => {
    await harness(async (h) => {
      const fidel = await groupWith(h, { pricingType: "discount", discountBps: 500 });
      const owner = await buyer(h, null);
      const p = await product(h);
      const before = await lineOf(h, owner, p.variantId);
      expect(before.pricing.totalMinor).toBe(19_900);
      expect(before.view.canCheckout).toBe(true);

      await h.tx.user.update({
        where: { id: owner.userId },
        data: { customerGroupId: fidel.id },
      });
      const after = await h.cart.view(owner);
      expect(after.lines[0]?.pricing?.totalMinor).toBe(18_905);
      expect(after.lines[0]?.issues).toEqual([
        { type: "price_changed", fromMinor: 19_900, toMinor: 18_905 },
      ]);
      expect(after.canCheckout).toBe(false);

      const confirmed = await h.cart.acknowledgePrice(owner, p.variantId);
      expect(confirmed.view.lines[0]?.issues).toEqual([]);
      expect(confirmed.view.canCheckout).toBe(true);
      expect(confirmed.view.lines[0]?.pricing?.totalMinor).toBe(18_905);
    });
  });

  it("un client logat care adaugă în coș are prețul de grup confirmat din start (fără mesaj fals)", async () => {
    await harness(async (h) => {
      const fidel = await groupWith(h, { pricingType: "discount", discountBps: 500 });
      const partner = await groupWith(h, { pricingType: "cost_plus", markupBps: 1200 });
      const p = await product(h, { cost: 10_000 });
      for (const group of [fidel, partner]) {
        const owner = await buyer(h, group.id);
        const { line, view } = await lineOf(h, owner, p.variantId);
        expect(line.issues).toEqual([]);
        expect(view.canCheckout).toBe(true);
      }
    });
  });
});
