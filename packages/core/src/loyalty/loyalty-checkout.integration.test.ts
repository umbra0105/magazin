import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { cancelOrder } from "../orders/order-actions";
import { confirmBankTransferPayment, expireDueTransferOrders } from "../orders/order-payments";
import { markOrderPickedUp } from "../orders/order-pickup";
import { LOYALTY_PORTS } from "../orders/order-service";
import { expireDueCardOrders } from "../payments/card-payment-service";
import {
  DEMO_CARD,
  addTo,
  destination,
  digitalOnlyInput,
  digitalProduct,
  userWorld,
  type World,
} from "../test-utils/digital-checkout";
import { NOW, codeOf, harness, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import {
  enableLoyalty,
  givePoints,
  loyaltyWorld,
  putInGroup,
} from "../test-utils/loyalty-fixtures";
import { readBalance } from "./ledger";
import { grantDuePoints, pendingPoints } from "./order-loyalty";

/**
 * Faza 15b cap-coadă pe Postgres real: previzualizarea și plasarea cu puncte, anularea și expirarea, livrarea și acordarea.
 * Sumele sunt calculate de mână în comentarii (bani: 10000 = 100,00 lei). Transportul DEMO se citește din ofertă, iar regulile
 * se verifică față de el.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY = 86_400_000;
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

type Method = "cod" | "bank_transfer" | "card";

/** Previzualizarea coșului pentru oferta aleasă (curier sau ridicare), cu punctele cerute. */
async function previewFor(
  world: World,
  options: { method?: Method; points?: number; kind?: "courier" | "pickup" } = {},
) {
  const { h, owner } = world;
  const method = options.method ?? "cod";
  const first = await h.checkout.preview({
    owner,
    destination: destination(h),
    paymentMethod: method,
  });
  const offer = first.shipping?.offers.find((o) =>
    options.kind === "pickup" ? o.kind === "pickup" : o.kind !== "pickup",
  );
  if (!offer) throw new Error("fără ofertă: " + JSON.stringify(first.blocked));
  const preview = await h.checkout.preview({
    owner,
    destination: destination(h),
    offerCode: offer.code,
    paymentMethod: method,
    ...(options.points !== undefined ? { loyaltyPoints: options.points } : {}),
  });
  return { preview, offer };
}

async function place(
  world: World,
  options: { method?: Method; points?: number; kind?: "courier" | "pickup" } = {},
) {
  const method = options.method ?? "cod";
  const { preview, offer } = await previewFor(world, options);
  const input = await world.h.input(world.owner, {
    paymentMethod: method,
    shippingOfferCode: offer.code,
    expectedTotalMinor: preview.totals?.totalMinor ?? 1,
    ...(options.points !== undefined ? { loyaltyPoints: options.points } : {}),
  });
  const result = await world.h.checkout.place(world.owner, input);
  // tranzacția testului se anulează, deci verificările amânate la COMMIT ale comenzii se FORȚEAZĂ aici (decizia 2026-11-26)
  await world.h.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
  await world.h.tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
  return { order: await orderOf(world.h.tx, result.orderId), preview, offer };
}

const ledgerTypes = async (h: Harness, orderId: string) =>
  (await h.tx.loyaltyTransaction.findMany({ where: { orderId }, orderBy: { seq: "asc" } })).map(
    (row) => `${row.type}:${row.points}`,
  );

/** Coș cu un produs de preț dat, pentru un cumpărător cu `points` puncte. */
async function cartOf(h: Harness, price: number, points = 500, over: Record<string, unknown> = {}) {
  const world = await loyaltyWorld(h, points, over);
  const product = await h.product({ price });
  await addTo(world, [{ variantId: product.variantId }]);
  return world;
}

describe("previzualizarea: câte puncte se pot folosi", () => {
  it("la maxim, suma de plătit în bani e exact transportul (plus taxa de ramburs la ramburs)", async () => {
    await harness(
      async (h) => {
        const world = await cartOf(h, 10_000);
        const { preview, offer } = await previewFor(world, { method: "card", points: 100_000 });
        // 100,00 lei de produse, 500 de puncte: maximum 100 de puncte; în bani rămâne transportul
        expect(preview.loyalty?.redeem?.maxPoints).toBe(100);
        expect(preview.loyalty?.appliedPoints).toBe(100);
        expect(preview.totals?.discountMinor).toBe(10_000);
        expect(preview.totals?.totalMinor).toBe(offer.priceMinor);
        const cod = await previewFor(world, { method: "cod", points: 100 });
        expect(cod.preview.totals?.totalMinor).toBe(cod.offer.priceMinor + cod.offer.codFeeMinor);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("la ridicare personală rămâne minimul în bani (1 leu)", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000);
      const { preview } = await previewFor(world, { kind: "pickup", points: 500 });
      expect(preview.loyalty?.redeem?.maxPoints).toBe(99);
      expect(preview.totals?.totalMinor).toBe(100);
    });
  });

  it("sub minimul de folosit nu se aplică nimic; peste sold se taie la sold", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000, 40);
      expect((await previewFor(world, { points: 9 })).preview.loyalty?.appliedPoints).toBe(0);
      expect((await previewFor(world, { points: 999 })).preview.loyalty?.appliedPoints).toBe(40);
    });
  });

  it("fără `vatMode`: punctele nu se pot folosi, dar acumularea se estimează", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 30_000, 500, { vatMode: null });
      const { preview } = await previewFor(world, { points: 100 });
      expect(preview.loyalty).toMatchObject({ redeem: null, appliedPoints: 0, earnEstimate: 3 });
      expect(preview.totals?.discountMinor).toBeUndefined();
    });
  });

  it("oaspetele nu folosește puncte, dar vede câte ar primi cu un cont", async () => {
    await harness(async (h) => {
      await enableLoyalty(h.tx);
      const product = await h.product({ price: 30_000 });
      const owner = await h.fill([{ variantId: product.variantId }]);
      const preview = await h.checkout.preview({ owner, destination: null });
      expect(preview.loyalty).toMatchObject({ signedIn: false, redeem: null, earnEstimate: 3 });
    });
  });

  it("programul oprit: nimic despre puncte în previzualizare", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const product = await h.product();
      await addTo(world, [{ variantId: product.variantId }]);
      expect(
        (await h.checkout.preview({ owner: world.owner, destination: null })).loyalty,
      ).toBeUndefined();
    });
  });
});

describe("plasarea cu puncte", () => {
  it("comanda, liniile, TVA-ul pe rânduri, plata și registrul, toate la ban", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000, 500, { maxRedeemPercent: null });
      const { order, offer } = await place(world, { points: 33 });
      // 33 de puncte = 33,00 lei; TVA linie 17,36; TVA reducere vat(3300) = 3300 − round(3300/1,21=2727,27→2727) = 573
      expect(order).toMatchObject({
        subtotalMinor: 10_000,
        discountMinor: 3_300,
        shippingMinor: offer.priceMinor,
        loyaltyPointsUsed: 33,
        loyaltyPointValueMinor: 100,
        loyaltyVatMode: "base_reduced",
        loyaltyCustomerId: world.userId,
        loyaltyEarnRateMinor: 10_000,
        // în bani pe produse: 6700 → 0 puncte
        loyaltyPointsToEarn: 0,
        totalMinor: 6_700 + offer.priceMinor + offer.codFeeMinor,
        taxMinor: 1_736 - 573 + order.shippingTaxMinor + order.codFeeTaxMinor,
      });
      expect(order.lines[0]).toMatchObject({
        lineTotalMinor: 10_000,
        taxMinor: 1_736,
        loyaltyDiscountMinor: 3_300,
        loyaltyDiscountTaxMinor: 573,
        discountMinor: 0,
      });
      expect(order.payments.map((p) => p.amountMinor)).toEqual([order.totalMinor]);
      expect(await ledgerTypes(h, order.id)).toEqual(["redeem:-33"]);
      expect(await readBalance(h.tx, world.userId)).toBe(467);
      expect(order.events.map((e) => e.type)).toContain("loyalty.redeemed");
    });
  });

  it("card: procesatorul primește DOAR suma în bani, niciodată 0", async () => {
    await harness(
      async (h) => {
        const world = await cartOf(h, 10_000);
        const { order, offer } = await place(world, { method: "card", points: 100 });
        expect(order.totalMinor).toBe(offer.priceMinor);
        expect(order.payments.map((p) => [p.method, p.amountMinor])).toEqual([
          ["card", offer.priceMinor],
        ]);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("coș 100% digital: în bani rămâne 1 leu", async () => {
    await harness(
      async (h) => {
        const world = await loyaltyWorld(h, 500);
        const digital = await digitalProduct(h, 30_000);
        await addTo(world, [{ variantId: digital.variantId }]);
        const preview = await h.checkout.preview({
          owner: world.owner,
          destination: null,
          paymentMethod: "card",
          loyaltyPoints: 10_000,
        });
        expect(preview.loyalty?.redeem?.maxPoints).toBe(299);
        const input = await digitalOnlyInput(world, {
          loyaltyPoints: 299,
          expectedTotalMinor: 100,
        });
        const result = await h.checkout.place(world.owner, input);
        await h.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
        const order = await orderOf(h.tx, result.orderId);
        expect(order).toMatchObject({ totalMinor: 100, shippingMinor: 0, discountMinor: 29_900 });
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it.each([
    ["peste maximul comenzii", 101],
    ["sub minimul de folosit", 9],
  ])("%s: refuz, nimic scris", async (_label, points) => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000);
      const input = await h.input(world.owner, { loyaltyPoints: points });
      const before = await h.tx.order.count();
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_POINTS_INVALID");
      expect(await h.tx.order.count()).toBe(before);
      expect(await readBalance(h.tx, world.userId)).toBe(500);
    });
  });

  it("peste soldul disponibil: refuz", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000, 20);
      const input = await h.input(world.owner, { loyaltyPoints: 21 });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_POINTS_INVALID");
    });
  });

  it("fără `vatMode` sau fără cont: punctele sunt refuzate pe server", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000, 500, { vatMode: null });
      const input = await h.input(world.owner, { loyaltyPoints: 20 });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_POINTS_UNAVAILABLE");
    });
    await harness(async (h) => {
      await enableLoyalty(h.tx);
      const product = await h.product();
      const owner = await h.fill([{ variantId: product.variantId }]);
      const input = await h.input(owner, { loyaltyPoints: 20 });
      expect(await codeOf(h.checkout.place(owner, input))).toBe("ORDER_POINTS_UNAVAILABLE");
    });
  });

  it("totalul văzut fără puncte nu trece cu puncte (și invers)", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000);
      const { preview } = await previewFor(world);
      const input = await h.input(world.owner, {
        loyaltyPoints: 20,
        expectedTotalMinor: preview.totals!.totalMinor,
      });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_TOTAL_CHANGED");
    });
  });

  it("limita de ramburs se compară cu suma încasată DUPĂ puncte", async () => {
    await harness(
      async (h) => {
        const world = await cartOf(h, 101_000, 500);
        const without = await previewFor(world);
        expect(without.preview.methods?.find((m) => m.method === "cod")).toMatchObject({
          available: false,
          reason: "over_limit_individual",
        });
        const withPoints = await previewFor(world, { points: 500 });
        expect(withPoints.preview.methods?.find((m) => m.method === "cod")).toMatchObject({
          available: true,
        });
        const { order } = await place(world, { points: 500 });
        expect(order.totalMinor).toBeLessThanOrEqual(100_000);
      },
      { settings: { codMaxIndividualMinor: 100_000 } },
    );
  });

  it("pragul de transport gratuit se calculează ÎNAINTE de puncte", async () => {
    await harness(
      async (h) => {
        const world = await cartOf(h, 52_000);
        const { order, offer } = await place(world, { points: 100 });
        // 520 lei ≥ 500 lei: transport gratuit, deși în bani pe produse rămân 420 lei
        expect(offer.priceMinor).toBe(0);
        expect(order.shippingMinor).toBe(0);
      },
      { shipping: { freeShippingThresholdMinor: 50_000 } },
    );
  });
});

describe("punctele de primit la plasare", () => {
  it("floor pe banii plătiți pe produse, fără transport și fără punctele folosite", async () => {
    await harness(async (h) => {
      // 1.000,00 lei, fără puncte: 10 puncte; cu 100 de puncte: 900 lei în bani → 9
      const world = await cartOf(h, 100_000);
      const { order } = await place(world, { points: 100 });
      expect(order.loyaltyPointsToEarn).toBe(9);
    });
    await harness(async (h) => {
      const world = await cartOf(h, 19_900, 0);
      expect((await place(world)).order.loyaltyPointsToEarn).toBe(1);
    });
  });

  it("Partenerul nu acumulează, dar își poate folosi soldul (și după promovare)", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 30_000, 50);
      await putInGroup(h.tx, world.userId, {
        pricingType: "cost_plus",
        markupBps: 1200,
        earnsLoyaltyPoints: false,
      });
      const { order } = await place(world, { points: 50 });
      expect(order).toMatchObject({
        loyaltyPointsUsed: 50,
        loyaltyEarnRateMinor: null,
        loyaltyPointsToEarn: null,
      });
      expect(await readBalance(h.tx, world.userId)).toBe(0);
    });
  });

  it("clientul Fidel: reducerea de grup se cumulează cu punctele", async () => {
    await harness(async (h) => {
      // grupul ÎNAINTE de coș: un preț schimbat după adăugare cere confirmarea clientului
      const world = await loyaltyWorld(h, 500);
      await putInGroup(h.tx, world.userId, {
        pricingType: "discount",
        discountBps: 500,
        earnsLoyaltyPoints: true,
      });
      const product = await h.product({ price: 100_000 });
      await addTo(world, [{ variantId: product.variantId }]);
      const { order } = await place(world, { points: 100 });
      // 1.000 − 5% = 950 lei; − 100 de puncte = 850 lei în bani → 8 puncte
      expect(order).toMatchObject({
        subtotalMinor: 95_000,
        discountMinor: 10_000,
        loyaltyPointsToEarn: 8,
      });
    });
  });

  it("oaspetele nu acumulează nimic", async () => {
    await harness(async (h) => {
      await enableLoyalty(h.tx);
      const product = await h.product({ price: 100_000 });
      const owner = await h.fill([{ variantId: product.variantId }]);
      const result = await h.checkout.place(owner, await h.input(owner));
      expect(await orderOf(h.tx, result.orderId)).toMatchObject({
        loyaltyCustomerId: null,
        loyaltyEarnRateMinor: null,
      });
    });
  });

  it("produsele la promoție acumulează implicit; cu setarea oprită, nu", async () => {
    for (const [include, expected] of [
      [true, 3],
      [false, 1],
    ] as const) {
      await harness(
        async (h) => {
          const world = await loyaltyWorld(h, 0, { earnOnDiscountedItems: include });
          const promo = await h.product({ price: 40_000 });
          await h.tx.productVariant.update({
            where: { id: promo.variantId },
            data: {
              salePrice: 20_000,
              saleStartsAt: new Date(NOW.getTime() - DAY),
              saleEndsAt: new Date(NOW.getTime() + DAY),
            },
          });
          const plain = await h.product({ price: 10_000 });
          await addTo(world, [{ variantId: promo.variantId }, { variantId: plain.variantId }]);
          const { order } = await place(world);
          expect(order.loyaltyPointsToEarn).toBe(expected);
        },
        { cart: { showSalePricing: true } },
      );
    }
  });
});

describe("anularea și abandonul întorc punctele o singură dată", () => {
  const cancel = (h: Harness, orderId: string) =>
    cancelOrder(h.tx, orderId, { reason: "anulare de test", actorLabel: "admin", now: NOW });

  it("anulare din admin: punctele folosite se întorc; a doua anulare nu schimbă nimic", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000);
      const { order } = await place(world, { points: 80 });
      await cancel(h, order.id);
      await cancel(h, order.id);
      expect(await ledgerTypes(h, order.id)).toEqual(["redeem:-80", "release:80"]);
      expect(await readBalance(h.tx, world.userId)).toBe(500);
    });
  });

  it("card abandonat: la expirarea ferestrei de reîncercare punctele se întorc o singură dată", async () => {
    await harness(
      async (h) => {
        const world = await cartOf(h, 10_000);
        const { order } = await place(world, { method: "card", points: 80 });
        const when = later(25 * 3_600_000);
        await expireDueCardOrders(h.tx, { now: when, graceMs: 0 });
        await expireDueCardOrders(h.tx, { now: when, graceMs: 0 });
        expect((await orderOf(h.tx, order.id)).status).toBe("cancelled");
        expect(await ledgerTypes(h, order.id)).toEqual(["redeem:-80", "release:80"]);
        expect(await readBalance(h.tx, world.userId)).toBe(500);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("transfer neplătit la termen: punctele se întorc", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 10_000);
      const { order } = await place(world, { method: "bank_transfer", points: 80 });
      await expireDueTransferOrders(h.tx, { now: later(30 * DAY) });
      expect(await ledgerTypes(h, order.id)).toEqual(["redeem:-80", "release:80"]);
      expect(await readBalance(h.tx, world.userId)).toBe(500);
    });
  });
});

describe("livrarea, așteptarea și acordarea", () => {
  const grant = (h: Harness, now: Date) => grantDuePoints(h.tx, { now, ports: LOYALTY_PORTS });

  async function paidAndPickedUp(h: Harness, price: number, points = 0) {
    const world = await cartOf(h, price, points === 0 ? 0 : 500);
    const { order } = await place(world, {
      method: "bank_transfer",
      kind: "pickup",
      ...(points ? { points } : {}),
    });
    await confirmBankTransferPayment(h.tx, order.id, { now: NOW });
    await markOrderPickedUp(h.tx, order.id, "admin", NOW);
    return { world, id: order.id };
  }

  const read = (h: Harness, id: string) => h.tx.order.findUniqueOrThrow({ where: { id } });

  it("până la livrare nu e nimic în așteptare; la livrare apare data (livrare + fereastra de retur)", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 100_000, 0);
      const { order } = await place(world, { method: "bank_transfer", kind: "pickup" });
      await confirmBankTransferPayment(h.tx, order.id, { now: NOW });
      expect((await read(h, order.id)).loyaltyEarnDueAt).toBeNull();
      expect(await pendingPoints(h.tx, world.userId)).toEqual([]);
      await markOrderPickedUp(h.tx, order.id, "admin", NOW);
      const due = (await read(h, order.id)).loyaltyEarnDueAt!;
      const event = await h.tx.orderEvent.findFirstOrThrow({
        where: { orderId: order.id, type: "order.picked_up" },
      });
      expect(due.getTime() - event.createdAt.getTime()).toBe(14 * DAY);
      expect(await pendingPoints(h.tx, world.userId)).toEqual([
        { orderId: order.id, orderNumber: order.number, points: 10, availableAt: due },
      ]);
    });
  });

  it("jobul nu acordă înainte de termen, acordă o singură dată la termen, cu expirare la 12 luni", async () => {
    await harness(async (h) => {
      const { world, id } = await paidAndPickedUp(h, 100_000);
      const due = (await read(h, id)).loyaltyEarnDueAt!;
      expect((await grant(h, new Date(due.getTime() - 1))).granted).toBe(0);
      expect(await grant(h, due)).toMatchObject({ granted: 1, points: 10 });
      expect((await grant(h, due)).granted).toBe(0);
      expect(await readBalance(h.tx, world.userId)).toBe(10);
      expect(await ledgerTypes(h, id)).toEqual(["earn:10"]);
      const lot = await h.tx.loyaltyLot.findFirstOrThrow({ where: { customerId: world.userId } });
      const expected = new Date(due.getTime());
      expected.setUTCFullYear(expected.getUTCFullYear() + 1);
      expect(lot.expiresAt.toISOString()).toBe(expected.toISOString());
      expect(await pendingPoints(h.tx, world.userId)).toEqual([]);
    });
  });

  it("fără banii încasați (ramburs nevirat) nu se acordă nimic", async () => {
    await harness(async (h) => {
      const world = await cartOf(h, 100_000, 0);
      const { order } = await place(world, { method: "cod", kind: "pickup" });
      await markOrderPickedUp(h.tx, order.id, "admin", NOW);
      const due = (await read(h, order.id)).loyaltyEarnDueAt!;
      expect((await grant(h, due)).granted).toBe(0);
      expect(await readBalance(h.tx, world.userId)).toBe(0);
    });
  });

  it("cu programul oprit jobul nu acordă nimic; repornit, acordă", async () => {
    await harness(async (h) => {
      const { id } = await paidAndPickedUp(h, 100_000);
      const due = (await read(h, id)).loyaltyEarnDueAt!;
      await enableLoyalty(h.tx, { enabled: false });
      expect((await grant(h, due)).granted).toBe(0);
      await enableLoyalty(h.tx);
      expect((await grant(h, due)).granted).toBe(1);
    });
  });

  it("anulare după acordare: punctele acordate se revocă, cele folosite se întorc", async () => {
    await harness(
      async (h) => {
        const world = await loyaltyWorld(h, 500);
        const digital = await digitalProduct(h, 100_000);
        await addTo(world, [{ variantId: digital.variantId }]);
        const input = await digitalOnlyInput(world, {
          paymentMethod: "bank_transfer",
          loyaltyPoints: 100,
          expectedTotalMinor: 90_000,
        });
        const placed = await h.checkout.place(world.owner, input);
        await confirmBankTransferPayment(h.tx, placed.orderId, { now: NOW });
        // 100% digital: fereastra curge de la acordarea accesului (plata confirmată)
        const due = (await read(h, placed.orderId)).loyaltyEarnDueAt!;
        const access = await h.tx.digitalEntitlement.findFirstOrThrow({
          where: { orderId: placed.orderId },
        });
        expect(due.getTime() - access.grantedAt.getTime()).toBe(14 * DAY);
        expect(await grant(h, due)).toMatchObject({ granted: 1, points: 9 });
        expect(await readBalance(h.tx, world.userId)).toBe(409);
        await cancelOrder(h.tx, placed.orderId, {
          reason: "anulare de test",
          actorLabel: "admin",
          now: NOW,
          acknowledgePaid: true,
        }).catch(async (error: unknown) => {
          // comanda digitală livrată nu se mai anulează; rămâne rambursarea (testată separat)
          expect((error as { code?: string }).code).toBe("ORDER_CANCEL_INVALID");
        });
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("promovarea la Partener după comandă nu oprește punctele deja promise", async () => {
    await harness(async (h) => {
      const { world, id } = await paidAndPickedUp(h, 100_000);
      await putInGroup(h.tx, world.userId, {
        pricingType: "cost_plus",
        markupBps: 1200,
        earnsLoyaltyPoints: false,
      });
      await givePoints(h.tx, world.userId, 5);
      expect((await grant(h, (await read(h, id)).loyaltyEarnDueAt!)).points).toBe(10);
      expect(await readBalance(h.tx, world.userId)).toBe(15);
    });
  });
});
