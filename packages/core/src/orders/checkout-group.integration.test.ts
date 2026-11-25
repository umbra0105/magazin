import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { buildInvoiceDraft } from "../invoicing/invoice-draft";
import type { CartOwner } from "../cart/cart-service";
import { NOW, codeOf, harness, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import { createUser } from "../test-utils/digital-fixtures";

/**
 * Comanda unui client cu grup (Faza 15): snapshot-ul grupului pe comandă, prețul din coș = prețul din comandă = prețul de pe factura
 * simulată (la 1 ban), avantajul calculat de motor (fără cost), rambursul pentru parteneri la limita persoanelor juridice.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const uid = (): string => randomUUID().slice(0, 8);

async function group(h: Harness, data: Record<string, unknown>) {
  return h.tx.customerGroup.create({
    data: { name: `Grup ${uid()}`, slug: `g-${uid()}`, ...data } as never,
  });
}

async function setup(
  h: Harness,
  groupId: string | null,
  prod: { price?: number; cost?: number | null; quantity?: string } = {},
) {
  const user = await createUser(h.tx, true);
  if (groupId)
    await h.tx.user.update({ where: { id: user.id }, data: { customerGroupId: groupId } });
  const owner: CartOwner = { kind: "user", userId: user.id };
  const p = await h.product({ price: prod.price ?? 19_900 });
  if (prod.cost !== undefined) {
    await h.tx.productVariant.update({
      where: { id: p.variantId },
      data: { costPrice: prod.cost },
    });
  }
  await h.cart.add(owner, { variantId: p.variantId, quantity: "minimum" });
  return { owner, user, p };
}

async function place(h: Harness, owner: CartOwner, over: Record<string, unknown> = {}) {
  const input = await h.input(owner, over);
  return h.checkout.place(owner, input);
}

function draftOf(order: Awaited<ReturnType<typeof orderOf>>) {
  return buildInvoiceDraft(
    {
      lines: order.lines.map((line) => ({
        id: line.id,
        sku: line.sku,
        title: line.title,
        variantTitle: line.variantTitle,
        quantityTicks: line.quantity,
        unitSymbol: line.unitSymbol,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
        netMinor: line.netMinor,
        taxMinor: line.taxMinor,
        taxRateBps: line.taxRateBps,
        dischargeable: true,
      })),
      discountMinor: order.discountMinor,
      shippingMinor: order.shippingMinor,
      shippingTaxMinor: order.shippingTaxMinor,
      codFeeMinor: order.codFeeMinor,
      codFeeTaxMinor: order.codFeeTaxMinor,
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
      taxRateBps: order.taxRateBps,
    },
    {
      unitName: (symbol) => symbol,
      labels: { shipping: "Transport", codFee: "Taxă ramburs", serviceUnit: "serviciu" },
    },
  );
}

describe("snapshot-ul grupului pe comandă", () => {
  it("Fidel 5%: grupul, procentul și avantajul; prețul din coș = comandă = factură simulată", async () => {
    await harness(async (h) => {
      const fidel = await group(h, { pricingType: "discount", discountBps: 500 });
      const { owner } = await setup(h, fidel.id);
      const view = await h.cart.view(owner);
      const preview = await h.checkout.preview({
        owner,
        destination: {
          countyCode: h.geo.countyCode,
          localityCode: h.geo.localityCode,
          postalCode: "123456",
        },
        offerCode: "demo:courier",
        paymentMethod: "cod",
      });
      const result = await place(h, owner);
      const order = await orderOf(h.tx, result.orderId);

      expect(order).toMatchObject({
        customerGroupId: fidel.id,
        groupPricingType: "discount",
        groupDiscountBps: 500,
        groupMarkupBps: null,
        groupAdvantageMinor: 995,
        discountMinor: 0,
      });
      expect(order.lines[0]).toMatchObject({ unitPriceMinor: 18_905, lineTotalMinor: 18_905 });
      expect(view.totals.totalMinor).toBe(18_905);
      expect(preview.totals?.totalMinor).toBe(order.totalMinor);
      const payment = order.payments[0];
      expect(payment?.amountMinor).toBe(order.totalMinor);

      // factura simulată: doar prețul încasat pe linie, fără rând de «avantaj» sau de reducere, totalul = ce a plătit clientul
      const draft = draftOf(order);
      expect(draft.totalMinor).toBe(order.totalMinor);
      expect(draft.taxMinor).toBe(order.taxMinor);
      const product = draft.lines.filter((line) => line.kind === "product");
      expect(product).toHaveLength(1);
      expect(product[0]?.lineTotalMinor).toBe(18_905);
      expect(draft.lines.some((line) => /avantaj|reducere/i.test(line.title))).toBe(false);
    });
  });

  it("Partener 1: snapshot cu adaosul; avantajul e prețul public minus prețul încasat; nimic despre cost în comandă", async () => {
    await harness(async (h) => {
      const partner = await group(h, {
        pricingType: "cost_plus",
        markupBps: 1200,
        earnsLoyaltyPoints: false,
      });
      const { owner } = await setup(h, partner.id, { cost: 10_007 });
      const result = await place(h, owner);
      const order = await orderOf(h.tx, result.orderId);
      // 10.007 × 1,12 × 1,21 = 13.561,4 → 13.561
      expect(order.lines[0]?.unitPriceMinor).toBe(13_561);
      expect(order).toMatchObject({
        customerGroupId: partner.id,
        groupPricingType: "cost_plus",
        groupDiscountBps: null,
        groupMarkupBps: 1200,
        groupAdvantageMinor: 19_900 - 13_561,
      });
      // costul nu ajunge în nicio coloană a comenzii sau a liniilor, nici în instantaneu (chei, nu text: un id poate conține orice)
      const keys: string[] = [];
      const numbers: number[] = [];
      const walk = (value: unknown): void => {
        if (typeof value === "number") numbers.push(value);
        if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          for (const [key, inner] of Object.entries(value)) {
            keys.push(key);
            walk(inner);
          }
        }
      };
      walk(
        JSON.parse(JSON.stringify(order, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      );
      expect(keys.filter((key) => /cost/i.test(key))).toEqual([]);
      expect(numbers).not.toContain(10_007);
      expect(JSON.stringify(order.lines.map((line) => line.productSnapshot))).not.toMatch(/10007/);
    });
  });

  it("«Client standard» (none): grupul se păstrează pe comandă, fără procente și fără avantaj", async () => {
    await harness(async (h) => {
      const standard = await group(h, { pricingType: "none" });
      const { owner } = await setup(h, standard.id);
      const order = await orderOf(h.tx, (await place(h, owner)).orderId);
      expect(order).toMatchObject({
        customerGroupId: standard.id,
        groupPricingType: "none",
        groupDiscountBps: null,
        groupMarkupBps: null,
        groupAdvantageMinor: 0,
      });
      expect(order.lines[0]?.unitPriceMinor).toBe(19_900);
    });
  });

  it("client fără grup și oaspete: ca înainte (none, fără grup, avantaj 0)", async () => {
    await harness(async (h) => {
      const { owner } = await setup(h, null);
      const a = await orderOf(h.tx, (await place(h, owner)).orderId);
      const guest = await h.fill([{ variantId: (await h.product()).variantId }]);
      const b = await orderOf(h.tx, (await place(h, guest)).orderId);
      for (const order of [a, b]) {
        expect(order).toMatchObject({
          customerGroupId: null,
          groupPricingType: "none",
          groupDiscountBps: null,
          groupMarkupBps: null,
          groupAdvantageMinor: 0,
        });
      }
    });
  });

  it("schimbarea grupului sau a procentului după plasare nu modifică comanda veche", async () => {
    await harness(async (h) => {
      const fidel = await group(h, { pricingType: "discount", discountBps: 500 });
      const { owner, user } = await setup(h, fidel.id);
      const order = await orderOf(h.tx, (await place(h, owner)).orderId);
      await h.tx.customerGroup.update({ where: { id: fidel.id }, data: { discountBps: 1000 } });
      await h.tx.user.update({ where: { id: user.id }, data: { customerGroupId: null } });
      const after = await orderOf(h.tx, order.id);
      expect(after).toMatchObject({
        customerGroupId: fidel.id,
        groupDiscountBps: 500,
        groupAdvantageMinor: 995,
        totalMinor: order.totalMinor,
      });
      expect(after.lines[0]?.unitPriceMinor).toBe(18_905);
    });
  });

  it("totalul afișat înainte de schimbarea grupului nu mai e acceptat (ORDER_TOTAL_CHANGED)", async () => {
    await harness(async (h) => {
      const fidel = await group(h, { pricingType: "discount", discountBps: 500 });
      const { owner, user, p } = await setup(h, null);
      const staleInput = await h.input(owner);
      await h.tx.user.update({ where: { id: user.id }, data: { customerGroupId: fidel.id } });
      // coșul cere o decizie (prețul s-a schimbat): comanda NU se plasează în tăcere
      const code = await codeOf(h.checkout.place(owner, staleInput));
      expect(["ORDER_CART_NOT_READY", "ORDER_CART_CHANGED", "ORDER_TOTAL_CHANGED"]).toContain(code);
      await h.cart.acknowledgePrice(owner, p.variantId);
      expect(await codeOf(h.checkout.place(owner, staleInput))).toBe("ORDER_TOTAL_CHANGED");
      const fresh = await h.input(owner);
      const order = await orderOf(h.tx, (await h.checkout.place(owner, fresh)).orderId);
      expect(order.groupPricingType).toBe("discount");
      expect(NOW.getTime()).toBeGreaterThan(0);
    });
  });
});

describe("ramburs pentru parteneri", () => {
  it("un partener e tratat ca persoană juridică: limita de ramburs e cea pentru firme (5.000 lei)", async () => {
    await harness(async (h) => {
      const partner = await group(h, { pricingType: "cost_plus", markupBps: 1200 });
      const fidel = await group(h, { pricingType: "discount", discountBps: 500 });
      // la preț public 6.000,00 (peste 5.000, sub 10.000): partenerul fără cost plătește prețul public → refuzat la ramburs
      const a = await setup(h, partner.id, { price: 600_000 });
      expect(await codeOf(place(h, a.owner))).toBe("ORDER_PAYMENT_METHOD_UNAVAILABLE");
      // aceeași sumă, client Fidel: sub limita pentru persoane fizice (10.000 lei) → trece
      const b = await setup(h, fidel.id, { price: 600_000 });
      const order = await orderOf(h.tx, (await place(h, b.owner)).orderId);
      expect(order.groupPricingType).toBe("discount");
    });
  });

  it("partenerul sub limită comandă cu ramburs, la prețul lui", async () => {
    await harness(async (h) => {
      const partner = await group(h, { pricingType: "cost_plus", markupBps: 1200 });
      const a = await setup(h, partner.id, { price: 600_000, cost: 400_000 });
      // 4.000,00 × 1,12 × 1,21 = 5.420,80 > 5.000 + transport → refuzat; cu cost 300.000: 4.065,60 → trece
      expect(await codeOf(place(h, a.owner))).toBe("ORDER_PAYMENT_METHOD_UNAVAILABLE");
      const b = await setup(h, partner.id, { price: 600_000, cost: 300_000 });
      const order = await orderOf(h.tx, (await place(h, b.owner)).orderId);
      expect(order.lines[0]?.unitPriceMinor).toBe(406_560);
      expect(order.groupAdvantageMinor).toBe(600_000 - 406_560);
    });
  });
});
