import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { parseQuantity, type Quantity } from "@ecom/shared";
import { MAX_MONEY } from "../catalog/product-schemas";
import { runBaseSeed } from "../seed/base-seed";
import { displayedPrice } from "../storefront/listing-price";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { hashCartToken } from "./cart-rules";
import {
  CartService,
  type CartOwner,
  type CartRuntimeSettings,
  type CartView,
} from "./cart-service";

/**
 * Coșul (Faza 8) pe Postgres real, în tranzacție anulată. Nu presupune seed: depozitul implicit îl creează `runBaseSeed`,
 * produsele le creează testul. Ceasul e injectat (`NOW`); promoțiile și termenele pleacă din el.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const storage = new LocalStorageDriver({
  rootDir: "unused-in-test",
  appUrl: "https://magazin.test",
  signingKey: deriveSigningKey(Buffer.alloc(32, 7).toString("base64")),
});
const NOW = new Date("2030-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const q = (text: string): Quantity => parseQuantity(text, { maxDecimals: 4 });

const DEFAULTS: CartRuntimeSettings = {
  showSalePricing: false,
  taxStandardRate: 21,
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  guestCartDays: 30,
  userCartDays: 90,
  maxLines: 50,
  maxStepsPerLine: 1000,
  freeShippingThreshold: null,
};

interface ProductOpts extends ProductSpec {
  price?: number;
  salePrice?: number | null;
  priceBasis?: "unit" | "step";
  physical?: string;
  leadTimeDays?: number;
  costPrice?: number;
}

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: CartService;
  settings: CartRuntimeSettings;
  /** Un produs ACTIV cu o variantă; întoarce id-ul variantei. */
  product: (opts?: ProductOpts) => Promise<{ variantId: string; productId: string }>;
  guest: (token?: string | null) => CartOwner;
  user: () => Promise<CartOwner & { kind: "user" }>;
}

async function withCart<T>(
  fn: (h: Harness) => Promise<T>,
  over: Partial<CartRuntimeSettings> = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const settings: CartRuntimeSettings = { ...DEFAULTS, ...over };
    const service = new CartService({
      db: tx,
      storage,
      readSettings: async () => settings,
      now: () => NOW,
    });
    const h: Harness = {
      tx,
      ctx,
      service,
      settings,
      product: async (opts = {}) => {
        const { price, salePrice, priceBasis, physical, leadTimeDays, costPrice, ...spec } = opts;
        const created = await addStockProduct(tx, ctx, {
          status: "active",
          variants: [{ physical: physical ?? "100" }],
          ...spec,
        });
        const variant = created.variants[0]!;
        await tx.productVariant.update({
          where: { id: variant.id },
          data: {
            price: price ?? 19900,
            salePrice: salePrice ?? null,
            saleStartsAt: salePrice ? new Date(NOW.getTime() - DAY) : null,
            saleEndsAt: salePrice ? new Date(NOW.getTime() + DAY) : null,
            costPrice: costPrice ?? null,
          },
        });
        await tx.product.update({
          where: { id: created.productId },
          data: {
            ...(priceBasis && { priceBasis }),
            ...(leadTimeDays !== undefined && { leadTimeDays }),
          },
        });
        return { variantId: variant.id, productId: created.productId };
      },
      guest: (token = null) => ({ kind: "guest", token }),
      user: async () => {
        const id = `u_${randomUUID().slice(0, 12)}`;
        await tx.user.create({
          data: { id, name: "Client test", email: `${id}@test.invalid`, emailVerified: true },
        });
        return { kind: "user", userId: id };
      },
    };
    return fn(h);
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "fără cod";
  }
  return "nicio eroare";
}

const only = (view: CartView) => view.lines[0]!;

describe("coșul de oaspete: token, amprentă, proprietate", () => {
  it("prima adăugare creează coșul și întoarce un token; în bază stă DOAR amprenta", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const result = await h.service.add(h.guest(), { variantId, quantity: q("2") });
      const token = result.newToken!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const carts = await h.tx.cart.findMany();
      expect(carts).toHaveLength(1);
      expect(carts[0]!.tokenHash).toBe(hashCartToken(token));
      expect(carts[0]!.userId).toBeNull();
      expect(JSON.stringify(carts)).not.toContain(token);
      // a doua adăugare, cu tokenul: același coș, fără token nou
      const second = await h.service.add(h.guest(token), { variantId, quantity: q("1") });
      expect(second.newToken).toBeNull();
      expect(await h.tx.cart.count()).toBe(1);
      expect(only(second.view).quantityTicks).toBe("30000");
    });
  });

  it("un token străin, inexistent sau prost format nu dă acces la niciun coș (și nu se creează nimic la citire)", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const a = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      for (const stranger of [
        "A".repeat(43),
        "x".repeat(10),
        "!".repeat(43),
        a.newToken!.slice(0, 42) + (a.newToken!.endsWith("A") ? "B" : "A"),
      ]) {
        const view = await h.service.view(h.guest(stranger));
        expect(view.lines).toHaveLength(0);
      }
      expect(await h.service.view(h.guest(null))).toMatchObject({ lines: [] });
      expect(await h.tx.cart.count()).toBe(1);
    });
  });

  it("IDOR: un coș se atinge DOAR prin tokenul lui sau de proprietarul logat; operațiile pe variante nu trec în alt coș", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const a = await h.service.add(h.guest(), { variantId, quantity: q("2") });
      const b = await h.service.add(h.guest(), { variantId, quantity: q("5") });
      expect(a.newToken).not.toBe(b.newToken);
      // B modifică și șterge «aceeași variantă»: coșul lui A rămâne neatins
      await h.service.setQuantity(h.guest(b.newToken), { variantId, quantity: q("7") });
      await h.service.remove(h.guest(b.newToken), variantId);
      const viewA = await h.service.view(h.guest(a.newToken));
      expect(only(viewA).quantityTicks).toBe("20000");
      // utilizatorul logat nu vede coșul de oaspete
      const u = await h.user();
      expect((await h.service.view(u)).lines).toHaveLength(0);
      // nicio operație nu primește un id de coș sau de linie: doar proprietarul și varianta
      expect(await h.service.lineCount(h.guest(a.newToken))).toBe(1);
      expect(await h.service.lineCount(h.guest(b.newToken))).toBe(0);
    });
  });

  it("coșul utilizatorului: unul singur, găsit după cont", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const u = await h.user();
      const first = await h.service.add(u, { variantId, quantity: q("1") });
      expect(first.newToken).toBeNull();
      await h.service.add(u, { variantId, quantity: q("2") });
      expect(await h.tx.cart.count({ where: { userId: u.userId } })).toBe(1);
      expect(only(await h.service.view(u)).quantityTicks).toBe("30000");
    });
  });
});

describe("prețul și totalul (motorul de prețuri)", () => {
  it("linie la preț public: total, net și TVA extras din brut (cota din setări)", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ price: 19900 });
      const result = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      const line = only(result.view);
      expect(line.pricing).toMatchObject({
        totalMinor: 19900,
        netMinor: 16446,
        vatMinor: 3454,
        taxRateBps: 2100,
      });
      expect(result.view.totals).toMatchObject({ totalMinor: 19900, vatMinor: 3454 });
    });
  });

  it("cota de TVA vine din setări: la 9% TVA-ul liniei se schimbă, totalul brut nu", async () => {
    await withCart(
      async (h) => {
        const { variantId } = await h.product({ price: 19900 });
        const result = await h.service.add(h.guest(), { variantId, quantity: q("1") });
        expect(only(result.view).pricing).toMatchObject({
          totalMinor: 19900,
          vatMinor: 1643,
          taxRateBps: 900,
        });
      },
      { taxStandardRate: 9 },
    );
  });

  it("3 cutii × 2,03 mp = 6,09 mp la 123,45 lei/mp = 751,81 (nu 751,80); suma liniilor = totalul", async () => {
    await withCart(async (h) => {
      const mozaic = await h.product({ price: 12345, step: "2,03" });
      const piesa = await h.product({ price: 999 });
      const owner = h.guest();
      const first = await h.service.add(owner, {
        variantId: mozaic.variantId,
        quantity: q("6,09"),
      });
      const second = await h.service.add(h.guest(first.newToken), {
        variantId: piesa.variantId,
        quantity: q("3"),
      });
      const view = second.view;
      expect(view.lines.map((l) => l.pricing?.totalMinor).sort()).toEqual([2997, 75181]);
      expect(view.totals.totalMinor).toBe(75181 + 2997);
      expect(view.totals.totalMinor).toBe(
        view.lines.reduce((a, l) => a + (l.pricing?.totalMinor ?? 0), 0),
      );
    });
  });

  it("bisulfat pe pas (R2): 2 saci × 120,00 lei = 240,00 lei", async () => {
    await withCart(async (h) => {
      const bisulfat = await h.product({ price: 12000, step: "25", priceBasis: "step" });
      const result = await h.service.add(h.guest(), {
        variantId: bisulfat.variantId,
        quantity: q("50"),
      });
      expect(only(result.view).pricing?.totalMinor).toBe(24000);
    });
  });

  it("UN SINGUR PREȚ: cu promoție activă și «reducerile» oprite coșul percepe prețul întreg, ca vitrina; cu ele pornite, promoția", async () => {
    for (const showSale of [false, true]) {
      await withCart(
        async (h) => {
          const { variantId } = await h.product({ price: 19900, salePrice: 15000 });
          const variant = await h.tx.productVariant.findUniqueOrThrow({ where: { id: variantId } });
          const shown = displayedPrice(variant, NOW, showSale);
          const result = await h.service.add(h.guest(), { variantId, quantity: q("1") });
          expect(only(result.view).pricing?.unitPriceMinor).toBe(shown.amount);
          expect(only(result.view).pricing?.totalMinor).toBe(showSale ? 15000 : 19900);
        },
        { showSalePricing: showSale },
      );
    }
  });

  it("prețul s-a schimbat după ultima confirmare: mesaj la linie, totalul urmează prețul CURENT, apoi se poate confirma", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ price: 19900 });
      const added = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      const owner = h.guest(added.newToken);
      expect(only(added.view).issues).toEqual([]);
      await h.tx.productVariant.update({ where: { id: variantId }, data: { price: 21900 } });
      const view = await h.service.view(owner);
      expect(only(view).issues).toEqual([
        { type: "price_changed", fromMinor: 19900, toMinor: 21900 },
      ]);
      expect(view.totals.totalMinor).toBe(21900);
      const acked = await h.service.acknowledgePrice(owner, variantId);
      expect(only(acked.view).issues).toEqual([]);
      // schimbarea cantității confirmă și ea prețul curent
      await h.tx.productVariant.update({ where: { id: variantId }, data: { price: 22900 } });
      expect(only(await h.service.view(owner)).issues).toHaveLength(1);
      const changed = await h.service.setQuantity(owner, { variantId, quantity: q("2") });
      expect(only(changed.view).issues).toEqual([]);
      expect(changed.view.totals.totalMinor).toBe(45800);
    });
  });

  it("costul de achiziție nu apare nicăieri în coș (nici selectat, nici în rezultat)", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ price: 19900, costPrice: 123_457 });
      const result = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      const text = JSON.stringify(result.view);
      expect(text).not.toContain("123457");
      expect(text.toLowerCase()).not.toContain("cost");
    });
  });
});

describe("pasul, minimul, stocul, plafoanele (validate pe server)", () => {
  it("pasul: 6,09 mp se acceptă (3 × 2,03), 6 mp se refuză; nimic nu se salvează la refuz", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ step: "2,03" });
      expect(await codeOf(h.service.add(h.guest(), { variantId, quantity: q("6") }))).toBe(
        "CART_INVALID_QUANTITY",
      );
      expect(await h.tx.cart.count()).toBe(0);
      const ok = await h.service.add(h.guest(), { variantId, quantity: q("6,09") });
      expect(only(ok.view).quantityTicks).toBe("60900");
      // și la modificare
      expect(
        await codeOf(h.service.setQuantity(h.guest(ok.newToken), { variantId, quantity: q("7") })),
      ).toBe("CART_INVALID_QUANTITY");
      expect(only(await h.service.view(h.guest(ok.newToken))).quantityTicks).toBe("60900");
    });
  });

  it("zero, negativ și sub minim se refuză", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ minSteps: 3 });
      expect(await codeOf(h.service.add(h.guest(), { variantId, quantity: q("0") }))).toBe(
        "CART_INVALID_QUANTITY",
      );
      expect(await codeOf(h.service.add(h.guest(), { variantId, quantity: q("2") }))).toBe(
        "CART_INVALID_QUANTITY",
      );
      expect(
        (await h.service.add(h.guest(), { variantId, quantity: q("3") })).view.lines,
      ).toHaveLength(1);
    });
  });

  it("adăugarea directă (piese de schimb): «minimum» pune minimul comandabil, în pași", async () => {
    await withCart(async (h) => {
      const bucati = await h.product();
      const mozaic = await h.product({ step: "2,03", minSteps: 2 });
      const first = await h.service.add(h.guest(), {
        variantId: bucati.variantId,
        quantity: "minimum",
      });
      const view = (
        await h.service.add(h.guest(first.newToken), {
          variantId: mozaic.variantId,
          quantity: "minimum",
        })
      ).view;
      const byVariant = Object.fromEntries(view.lines.map((l) => [l.variantId, l.quantityTicks]));
      expect(byVariant).toEqual({ [bucati.variantId]: "10000", [mozaic.variantId]: "40600" });
    });
  });

  it("stoc gestionat: peste disponibil se refuză, cu numărul de pași; coșul NU rezervă nimic", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ physical: "2" });
      expect(await codeOf(h.service.add(h.guest(), { variantId, quantity: q("3") }))).toBe(
        "CART_EXCEEDS_AVAILABLE",
      );
      const added = await h.service.add(h.guest(), { variantId, quantity: q("2") });
      expect(only(added.view).state).toBe("limited");
      const item = await h.tx.inventoryItem.findFirstOrThrow({ where: { variantId } });
      expect(item.reserved).toBe(0n);
      expect(item.committed).toBe(0n);
    });
  });

  it("stocul scade după adăugare: linia primește «exceeds_available», cantitatea nu se modifică tăcut", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ physical: "10" });
      const added = await h.service.add(h.guest(), { variantId, quantity: q("5") });
      await h.tx.inventoryItem.updateMany({ where: { variantId }, data: { physical: q("2") } });
      const view = await h.service.view(h.guest(added.newToken));
      expect(only(view).issues).toEqual([{ type: "exceeds_available", maxSteps: 2 }]);
      expect(only(view).quantityTicks).toBe("50000");
      expect(view.canCheckout).toBe(false);
    });
  });

  it("produs devenit indisponibil: linia e marcată, ieșită din total, iar o a doua linie rămâne în total", async () => {
    await withCart(async (h) => {
      const a = await h.product({ price: 10000, manageStock: false, stockStatus: "instock" });
      const b = await h.product({ price: 5000, manageStock: false, stockStatus: "instock" });
      const first = await h.service.add(h.guest(), { variantId: a.variantId, quantity: q("1") });
      const owner = h.guest(first.newToken);
      await h.service.add(owner, { variantId: b.variantId, quantity: q("1") });
      await h.tx.product.update({
        where: { id: a.productId },
        data: { stockStatus: "outofstock" },
      });
      const view = await h.service.view(owner);
      const lineA = view.lines.find((l) => l.variantId === a.variantId)!;
      expect(lineA.issues).toEqual([{ type: "unavailable" }]);
      expect(lineA.pricing).toBeNull();
      expect(view.totals.totalMinor).toBe(5000);
      expect(view.canCheckout).toBe(false);
      // nu se mai poate adăuga
      expect(await codeOf(h.service.add(owner, { variantId: a.variantId, quantity: q("1") }))).toBe(
        "CART_UNAVAILABLE",
      );
    });
  });

  it("produs arhivat, în coșul de gunoi sau ciornă: nu se adaugă; cel din coș devine indisponibil", async () => {
    await withCart(async (h) => {
      const archived = await h.product({ status: "archived" });
      const draft = await h.product({ status: "draft" });
      const trashed = await h.product();
      await h.tx.product.update({ where: { id: trashed.productId }, data: { deletedAt: NOW } });
      for (const p of [archived, draft, trashed]) {
        expect(
          await codeOf(h.service.add(h.guest(), { variantId: p.variantId, quantity: q("1") })),
        ).toBe("CART_NOT_SELLABLE");
      }
      const live = await h.product();
      const added = await h.service.add(h.guest(), { variantId: live.variantId, quantity: q("1") });
      await h.tx.product.update({ where: { id: live.productId }, data: { status: "archived" } });
      const view = await h.service.view(h.guest(added.newToken));
      expect(only(view).issues).toEqual([{ type: "unavailable" }]);
    });
  });

  it("o variantă inexistentă se refuză, fără să creeze coș", async () => {
    await withCart(async (h) => {
      expect(
        await codeOf(h.service.add(h.guest(), { variantId: "nu-exista", quantity: q("1") })),
      ).toBe("CART_NOT_SELLABLE");
      expect(await h.tx.cart.count()).toBe(0);
    });
  });

  it("plafoane tehnice: linii pe coș, pași pe linie, valoarea liniei (se REFUZĂ, nu se taie)", async () => {
    await withCart(
      async (h) => {
        const a = await h.product();
        const b = await h.product();
        const c = await h.product();
        const first = await h.service.add(h.guest(), { variantId: a.variantId, quantity: q("1") });
        const owner = h.guest(first.newToken);
        await h.service.add(owner, { variantId: b.variantId, quantity: q("1") });
        expect(
          await codeOf(h.service.add(owner, { variantId: c.variantId, quantity: q("1") })),
        ).toBe("CART_TOO_MANY_LINES");
        // cantitatea peste plafonul pe linie (aceeași variantă, prin adunare)
        await h.service.setQuantity(owner, { variantId: a.variantId, quantity: q("10") });
        expect(
          await codeOf(h.service.add(owner, { variantId: a.variantId, quantity: q("1") })),
        ).toBe("CART_EXCEEDS_LIMIT");
        expect(only(await h.service.view(owner)).quantityTicks).toBe("100000");
      },
      { maxLines: 2, maxStepsPerLine: 10 },
    );
    await withCart(async (h) => {
      const { variantId } = await h.product({ price: MAX_MONEY, manageStock: false });
      expect(await codeOf(h.service.add(h.guest(), { variantId, quantity: q("2") }))).toBe(
        "CART_LINE_TOO_EXPENSIVE",
      );
      expect(await h.tx.cartItem.count()).toBe(0);
    });
  });
});

describe("coș mixt: termenul cel mai lung (D6) și pragul de transport gratuit", () => {
  it("linii «La comandă» cu termene diferite: termenul coșului e cel mai lung", async () => {
    await withCart(async (h) => {
      const stock = await h.product({ physical: "10" });
      const slow = await h.product({
        manageStock: false,
        stockStatus: "onbackorder",
        leadTimeDays: 21,
      });
      const fast = await h.product({
        manageStock: false,
        stockStatus: "onbackorder",
        leadTimeDays: 5,
      });
      const first = await h.service.add(h.guest(), {
        variantId: stock.variantId,
        quantity: q("1"),
      });
      const owner = h.guest(first.newToken);
      await h.service.add(owner, { variantId: fast.variantId, quantity: q("1") });
      const view = (await h.service.add(owner, { variantId: slow.variantId, quantity: q("1") }))
        .view;
      expect(view.leadTime).toEqual({ days: 21, variantId: slow.variantId });
      expect(view.lines.find((l) => l.variantId === fast.variantId)?.leadTimeDays).toBe(5);
    });
  });

  it("«La comandă» nu are limită de cantitate (doar plafonul tehnic)", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product({ manageStock: false, stockStatus: "onbackorder" });
      const added = await h.service.add(h.guest(), { variantId, quantity: q("500") });
      expect(only(added.view).state).toBe("on_order");
      expect(only(added.view).issues).toEqual([]);
    });
  });

  it("prag gol = dezactivat: nu există indicator", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const view = (await h.service.add(h.guest(), { variantId, quantity: q("1") })).view;
      expect(view.freeShipping).toBeNull();
    });
  });

  it("prag setat: se compară cu totalul după reduceri, cu TVA, fără transport", async () => {
    await withCart(
      async (h) => {
        const { variantId } = await h.product({ price: 10000 });
        const first = await h.service.add(h.guest(), { variantId, quantity: q("1") });
        expect(first.view.freeShipping).toEqual({
          thresholdMinor: 30000,
          remainingMinor: 20000,
          reached: false,
        });
        const next = await h.service.setQuantity(h.guest(first.newToken), {
          variantId,
          quantity: q("3"),
        });
        expect(next.view.freeShipping).toEqual({
          thresholdMinor: 30000,
          remainingMinor: 0,
          reached: true,
        });
      },
      { freeShippingThreshold: 30000 },
    );
  });
});

describe("îmbinarea coșului de oaspete în coșul utilizatorului (la autentificare)", () => {
  it("cantitățile pe aceeași variantă se adună, restul se mută; coșul de oaspete dispare, tokenul nu mai e valabil", async () => {
    await withCart(async (h) => {
      const x = await h.product();
      const y = await h.product();
      const u = await h.user();
      await h.service.add(u, { variantId: x.variantId, quantity: q("3") });
      const g1 = await h.service.add(h.guest(), { variantId: x.variantId, quantity: q("2") });
      await h.service.add(h.guest(g1.newToken), { variantId: y.variantId, quantity: q("1") });
      const result = await h.service.mergeGuestIntoUser(g1.newToken!, u.userId);
      expect(result).toMatchObject({ merged: 2, clamped: 0, dropped: 0 });
      const view = await h.service.view(u);
      const byVariant = Object.fromEntries(view.lines.map((l) => [l.variantId, l.quantityTicks]));
      expect(byVariant).toEqual({ [x.variantId]: "50000", [y.variantId]: "10000" });
      expect((await h.service.view(h.guest(g1.newToken))).lines).toHaveLength(0);
      expect(await h.tx.cart.count({ where: { tokenHash: { not: null } } })).toBe(0);
    });
  });

  it("utilizator fără coș: coșul de oaspete devine coșul lui; a doua îmbinare nu face nimic (idempotent)", async () => {
    await withCart(async (h) => {
      const x = await h.product();
      const u = await h.user();
      const g = await h.service.add(h.guest(), { variantId: x.variantId, quantity: q("4") });
      expect(await h.service.mergeGuestIntoUser(g.newToken!, u.userId)).toMatchObject({
        merged: 1,
      });
      expect(only(await h.service.view(u)).quantityTicks).toBe("40000");
      expect(await h.service.mergeGuestIntoUser(g.newToken!, u.userId)).toEqual({
        merged: 0,
        clamped: 0,
        dropped: 0,
      });
      expect(only(await h.service.view(u)).quantityTicks).toBe("40000");
      expect(await h.tx.cart.count({ where: { userId: u.userId } })).toBe(1);
    });
  });

  it("suma peste plafonul pe linie se reduce la plafon, în pași întregi; peste plafonul de linii se renunță la surplus", async () => {
    await withCart(
      async (h) => {
        const a = await h.product({ step: "2,03" });
        const b = await h.product();
        const c = await h.product();
        const d = await h.product();
        const u = await h.user();
        await h.service.add(u, { variantId: a.variantId, quantity: q("6,09") }); // 3 pași
        await h.service.add(u, { variantId: b.variantId, quantity: q("1") });
        const g = await h.service.add(h.guest(), { variantId: a.variantId, quantity: q("6,09") }); // 3 pași
        await h.service.add(h.guest(g.newToken), { variantId: c.variantId, quantity: q("1") });
        await h.service.add(h.guest(g.newToken), { variantId: d.variantId, quantity: q("1") });
        const result = await h.service.mergeGuestIntoUser(g.newToken!, u.userId);
        expect(result).toEqual({ merged: 2, clamped: 1, dropped: 1 });
        const view = await h.service.view(u);
        expect(view.lines).toHaveLength(3);
        // 3 + 3 = 6 pași > 5: se reduce la 5 pași = 10,15 (rămâne multiplu exact al pasului)
        expect(view.lines.find((l) => l.variantId === a.variantId)?.quantityTicks).toBe("101500");
        expect(view.lines.some((l) => l.variantId === d.variantId)).toBe(false);
      },
      { maxLines: 3, maxStepsPerLine: 5 },
    );
  });

  it("un token străin sau inexistent nu îmbină nimic", async () => {
    await withCart(async (h) => {
      const u = await h.user();
      expect(await h.service.mergeGuestIntoUser("A".repeat(43), u.userId)).toEqual({
        merged: 0,
        clamped: 0,
        dropped: 0,
      });
      expect(await h.service.mergeGuestIntoUser("scurt", u.userId)).toEqual({
        merged: 0,
        clamped: 0,
        dropped: 0,
      });
    });
  });
});

describe("expirare și curățare", () => {
  it("expirarea vine din setări, iar fiecare modificare o prelungește", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const added = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      const cart = await h.tx.cart.findFirstOrThrow();
      expect(cart.expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
      await h.tx.cart.update({
        where: { id: cart.id },
        data: { expiresAt: new Date(NOW.getTime() + DAY) },
      });
      await h.service.setQuantity(h.guest(added.newToken), { variantId, quantity: q("2") });
      expect((await h.tx.cart.findFirstOrThrow()).expiresAt.getTime()).toBe(
        NOW.getTime() + 30 * DAY,
      );
      const u = await h.user();
      await h.service.add(u, { variantId, quantity: q("1") });
      expect(
        (await h.tx.cart.findFirstOrThrow({ where: { userId: u.userId } })).expiresAt.getTime(),
      ).toBe(NOW.getTime() + 90 * DAY);
    });
  });

  it("jobul de curățare șterge doar coșurile expirate (cu liniile lor)", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const old = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      const fresh = await h.service.add(h.guest(), { variantId, quantity: q("1") });
      await h.tx.cart.updateMany({
        where: { tokenHash: hashCartToken(old.newToken!) },
        data: { expiresAt: new Date(NOW.getTime() - 1) },
      });
      expect(await h.service.purgeExpired()).toBe(1);
      expect(await h.tx.cart.count()).toBe(1);
      expect(await h.tx.cartItem.count()).toBe(1);
      expect((await h.service.view(h.guest(fresh.newToken))).lines).toHaveLength(1);
      expect((await h.service.view(h.guest(old.newToken))).lines).toHaveLength(0);
    });
  });
});

describe("linia dispare cu produsul și nu ține nimic în urmă", () => {
  it("ștergerea definitivă a variantei scoate linia (cascadă); eliminarea unei linii o șterge", async () => {
    await withCart(async (h) => {
      const a = await h.product();
      const b = await h.product();
      const added = await h.service.add(h.guest(), { variantId: a.variantId, quantity: q("1") });
      const owner = h.guest(added.newToken);
      await h.service.add(owner, { variantId: b.variantId, quantity: q("1") });
      expect((await h.service.remove(owner, a.variantId)).view.lines).toHaveLength(1);
      await h.tx.productVariant.delete({ where: { id: b.variantId } });
      expect((await h.service.view(owner)).lines).toHaveLength(0);
    });
  });
});

describe("cross-sell în coș", () => {
  it("sugerează doar produse vandabile din relațiile «crosssell», fără cele deja în coș", async () => {
    await withCart(async (h) => {
      const main = await h.product();
      const accessory = await h.product();
      const hidden = await h.product({ status: "draft" });
      const alreadyIn = await h.product();
      for (const related of [accessory, hidden, alreadyIn]) {
        await h.tx.productRelation.create({
          data: {
            productId: main.productId,
            relatedProductId: related.productId,
            type: "crosssell",
          },
        });
      }
      // o relație de alt tip nu intră
      const upsell = await h.product();
      await h.tx.productRelation.create({
        data: { productId: main.productId, relatedProductId: upsell.productId, type: "upsell" },
      });
      const first = await h.service.add(h.guest(), { variantId: main.variantId, quantity: q("1") });
      const owner = h.guest(first.newToken);
      await h.service.add(owner, { variantId: alreadyIn.variantId, quantity: q("1") });
      expect(await h.service.crossSellProductIds(owner, 6)).toEqual([accessory.productId]);
    });
  });
});

describe("constrângeri în baza de date (CHECK) cu cazul «una setată, una nulă»", () => {
  it("proprietarul coșului: exact unul dintre utilizator și amprentă", async () => {
    await withCart(async (h) => {
      const u = await h.user();
      const expiresAt = new Date(NOW.getTime() + DAY);
      const insert = async (userId: string | null, tokenHash: string | null) => {
        await h.tx.$executeRaw`SAVEPOINT s`;
        try {
          await h.tx.cart.create({ data: { userId, tokenHash, expiresAt } });
          await h.tx.$executeRaw`RELEASE SAVEPOINT s`;
          return "ok";
        } catch {
          await h.tx.$executeRaw`ROLLBACK TO SAVEPOINT s`;
          return "refuzat";
        }
      };
      expect(await insert(u.userId, null)).toBe("ok");
      expect(await insert(null, "a".repeat(64))).toBe("ok");
      expect(await insert(null, null)).toBe("refuzat");
      const u2 = await h.user();
      expect(await insert(u2.userId, "b".repeat(64))).toBe("refuzat");
    });
  });

  it("cantitatea liniei: pozitivă și cel mult maximul; prețul confirmat nu poate fi negativ", async () => {
    await withCart(async (h) => {
      const { variantId } = await h.product();
      const u = await h.user();
      const cart = await h.tx.cart.create({
        data: { userId: u.userId, expiresAt: new Date(NOW.getTime() + DAY) },
      });
      const insert = async (quantity: bigint, acked: number | null = null) => {
        await h.tx.$executeRaw`SAVEPOINT s`;
        try {
          await h.tx.cartItem.create({
            data: { cartId: cart.id, variantId, quantity, ackedUnitPriceMinor: acked },
          });
          await h.tx.$executeRaw`ROLLBACK TO SAVEPOINT s`;
          return "ok";
        } catch {
          await h.tx.$executeRaw`ROLLBACK TO SAVEPOINT s`;
          return "refuzat";
        }
      };
      expect(await insert(1n)).toBe("ok");
      expect(await insert(1_000_000_000_000n)).toBe("ok");
      expect(await insert(0n)).toBe("refuzat");
      expect(await insert(-5n)).toBe("refuzat");
      expect(await insert(1_000_000_000_001n)).toBe("refuzat");
      expect(await insert(1n, -1)).toBe("refuzat");
      expect(await insert(1n, 0)).toBe("ok");
    });
  });
});
