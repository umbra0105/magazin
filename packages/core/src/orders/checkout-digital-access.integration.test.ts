import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { buildInvoiceDraft } from "../invoicing/invoice-draft";
import { NOW, harness, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import {
  DEMO_CARD,
  addTo,
  digitalOnlyInput,
  digitalProduct,
  mixedInput,
  userWorld,
} from "../test-utils/digital-checkout";
import { markBankTransferPaid } from "./order-payments-admin";
import { transitionOrder } from "./order-service";

/**
 * Faza 14c: comenzile plasate prin checkout merg prin acordarea accesului din Faza 14b (card și transfer la plata confirmată,
 * ramburs mixt DOAR la livrarea confirmată) și prin facturare: suma încasată = totalul facturii, la 1 ban, pentru comanda
 * digitală, mixtă cu card și mixtă cu ramburs. Plățile și facturarea nu sunt modificate de fază; aici se dovedește doar că
 * comenzile noi se leagă corect de ele.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const entitlements = (h: Harness, orderId: string) =>
  h.tx.digitalEntitlement.findMany({ where: { orderId } });

const pay = (h: Harness, orderId: string) =>
  transitionOrder(
    h.tx,
    orderId,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "Plata a fost confirmată" },
    NOW,
  );

/** Factura comenzii, construită din liniile ei înghețate, exact ca în serviciul de facturare. */
async function draftOf(h: Harness, orderId: string) {
  const order = await orderOf(h.tx, orderId);
  return {
    order,
    draft: buildInvoiceDraft(
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
          dischargeable: order.stockCommitments.some((c) => c.variantId === line.variantId),
          digital: line.isDigital,
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
        labels: { shipping: "Transport", codFee: "Taxă ramburs", serviceUnit: "buc" },
      },
    ),
  };
}

describe("accesul digital după comenzile plasate prin checkout", () => {
  it("100% digital cu cardul: nicio acordare la plasare, acces la plata confirmată, comanda se încheie (fără expediere)", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const d = await digitalProduct(h);
        await addTo(world, [{ variantId: d.variantId }]);
        const placed = await h.checkout.place(world.owner, await digitalOnlyInput(world));
        expect(await entitlements(h, placed.orderId)).toHaveLength(0);

        await pay(h, placed.orderId);
        const rows = await entitlements(h, placed.orderId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ customerId: world.userId, grantReason: "payment" });
        const order = await orderOf(h.tx, placed.orderId);
        expect(order.fulfillmentStatus).toBe("fulfilled");
        expect(await h.tx.shipment.count({ where: { orderId: placed.orderId } })).toBe(0);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("100% digital cu transfer bancar: acces la «Marchează plătit», nu înainte", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h, 25_000);
      await addTo(world, [{ variantId: d.variantId }]);
      const placed = await h.checkout.place(
        world.owner,
        await digitalOnlyInput(world, { paymentMethod: "bank_transfer" }),
      );
      expect(await entitlements(h, placed.orderId)).toHaveLength(0);

      await markBankTransferPaid(h.tx, placed.orderId, {
        amountMinor: 25_000,
        reference: "OP 123456",
        actorLabel: "admin@test.ro",
        now: NOW,
      });
      expect(await entitlements(h, placed.orderId)).toHaveLength(1);
      const order = await orderOf(h.tx, placed.orderId);
      expect(order.paymentStatus).toBe("paid");
      expect(order.fulfillmentStatus).toBe("fulfilled");
    });
  });

  it("mixt cu cardul: digitalul se livrează instant la plată, fizicul rămâne neexpediat", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const physical = await h.product({ price: 10_000 });
        const d = await digitalProduct(h, 20_000);
        await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
        const placed = await h.checkout.place(
          world.owner,
          await mixedInput(world, { paymentMethod: "card" }),
        );
        await pay(h, placed.orderId);
        const rows = await entitlements(h, placed.orderId);
        expect(rows).toHaveLength(1);
        const order = await orderOf(h.tx, placed.orderId);
        const digitalLine = order.lines.find((line) => line.isDigital);
        expect(rows[0]?.orderLineId).toBe(digitalLine?.id);
        // partea fizică: neatinsă (nicio expediere, comanda nu devine «livrată»)
        expect(order.fulfillmentStatus).toBe("unfulfilled");
        expect(await h.tx.shipment.count({ where: { orderId: placed.orderId } })).toBe(0);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("mixt cu ramburs: niciun acces la plasare sau la confirmare; accesul vine abia la livrarea confirmată", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const physical = await h.product({ price: 10_000 });
      const d = await digitalProduct(h, 20_000);
      await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
      const placed = await h.checkout.place(world.owner, await mixedInput(world));
      const order = await orderOf(h.tx, placed.orderId);
      expect(order).toMatchObject({ paymentMethod: "cod", status: "confirmed" });
      expect(await entitlements(h, placed.orderId)).toHaveLength(0);

      // coletul pleacă, dar nu a ajuns: tot fără acces
      await transitionOrder(
        h.tx,
        placed.orderId,
        { fulfillmentStatus: "fulfilled" },
        { type: "shipment.created", message: "AWB" },
        NOW,
      );
      await transitionOrder(
        h.tx,
        placed.orderId,
        { fulfillmentStatus: "in_transit" },
        { type: "order.shipped", message: "expediat" },
        NOW,
      );
      expect(await entitlements(h, placed.orderId)).toHaveLength(0);

      await transitionOrder(
        h.tx,
        placed.orderId,
        { fulfillmentStatus: "delivered" },
        { type: "order.delivered", message: "livrat" },
        NOW,
      );
      const rows = await entitlements(h, placed.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ customerId: world.userId, grantReason: "delivery" });
    });
  });

  it("rambursarea comenzii digitale retrage accesul acordat", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const d = await digitalProduct(h);
        await addTo(world, [{ variantId: d.variantId }]);
        const placed = await h.checkout.place(world.owner, await digitalOnlyInput(world));
        await pay(h, placed.orderId);
        expect(await entitlements(h, placed.orderId)).toHaveLength(1);
        await transitionOrder(
          h.tx,
          placed.orderId,
          { paymentStatus: "refunded" },
          { type: "payment.refunded", message: "rambursat" },
          NOW,
        );
        const rows = await entitlements(h, placed.orderId);
        expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });
});

describe("factura: suma încasată = totalul facturii, la 1 ban", () => {
  it("comandă 100% digitală: fără linie de transport, fără taxă de ramburs, totalul = plata", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const d = await digitalProduct(h, 12_345);
        await addTo(world, [{ variantId: d.variantId }]);
        const placed = await h.checkout.place(world.owner, await digitalOnlyInput(world));
        const { order, draft } = await draftOf(h, placed.orderId);
        expect(draft.lines.map((line) => line.kind)).toEqual(["product"]);
        expect(draft.lines[0]?.dischargeStock).toBe(false);
        expect(draft.useStock).toBe(false);
        expect(draft.totalMinor).toBe(order.totalMinor);
        expect(draft.totalMinor).toBe(order.payments[0]?.amountMinor);
        expect(draft.taxMinor).toBe(order.taxMinor);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("comandă mixtă cu cardul: transport doar pentru partea fizică, digitalul fără descărcare, totalul = plata", async () => {
    await harness(
      async (h) => {
        const world = await userWorld(h);
        const physical = await h.product({ price: 9_999 });
        const d = await digitalProduct(h, 12_345);
        await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
        const placed = await h.checkout.place(
          world.owner,
          await mixedInput(world, { paymentMethod: "card" }),
        );
        const { order, draft } = await draftOf(h, placed.orderId);
        expect(draft.lines.map((line) => line.kind)).toEqual(["product", "product", "shipping"]);
        const digitalLine = order.lines.find((line) => line.isDigital);
        const digitalDraft = draft.lines.find((line) => line.orderLineId === digitalLine?.id);
        expect(digitalDraft?.dischargeStock).toBe(false);
        expect(draft.totalMinor).toBe(order.totalMinor);
        expect(draft.totalMinor).toBe(order.payments[0]?.amountMinor);
        expect(draft.taxMinor).toBe(order.taxMinor);
      },
      { settings: { cardProvider: DEMO_CARD } },
    );
  });

  it("comandă mixtă cu ramburs: transport și taxă de ramburs doar o dată, totalul = suma de încasat", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const physical = await h.product({ price: 9_999 });
      const d = await digitalProduct(h, 12_345);
      await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
      const placed = await h.checkout.place(world.owner, await mixedInput(world));
      const { order, draft } = await draftOf(h, placed.orderId);
      expect(draft.lines.map((line) => line.kind)).toEqual([
        "product",
        "product",
        "shipping",
        "cod_fee",
      ]);
      expect(draft.totalMinor).toBe(order.totalMinor);
      expect(draft.totalMinor).toBe(order.payments[0]?.amountMinor);
      expect(draft.taxMinor).toBe(order.taxMinor);
      // stocul fizic descărcabil rămâne descărcabil; digitalul nu îl oprește
      expect(draft.lines.filter((line) => line.dischargeStock)).toHaveLength(1);
    });
  });
});
