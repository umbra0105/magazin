import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DemoCarrier } from "@ecom/integrations";
import { NOW, codeOf, harness, orderOf } from "../test-utils/checkout-fixtures";
import {
  addTo,
  digitalOnlyInput,
  digitalProduct,
  mixedInput,
  userWorld,
} from "../test-utils/digital-checkout";
import { listOrdersReadyToShip } from "./ready-to-ship";
import {
  createCarrierShipment,
  createManualShipment,
  listOrderShipments,
} from "./shipment-service";

/**
 * Faza 14c, decizia 4: o comandă 100% digitală nu intră niciodată în fluxul de expediere (nu apare în «gata de expediere», AWB-ul
 * e refuzat cu mesaj clar, nu are `Shipment`); la comenzile mixte, expedierea privește doar liniile fizice.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const ACTOR = { actorLabel: "admin@test.ro", now: NOW };
const demo = () => new DemoCarrier({ env: { E2E_HARNESS: "1" }, now: () => NOW });

describe("comanda 100% digitală nu se expediază", () => {
  it("nu apare în «gata de expediere», chiar dacă e confirmată și «neexpediată»; comanda mixtă apare", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const digital = await h.checkout.place(
        world.owner,
        await digitalOnlyInput(world, { paymentMethod: "bank_transfer" }),
      );
      // starea cea mai defavorabilă: confirmată și încă neexpediată (accesul nu a închis comanda)
      await h.tx.order.update({
        where: { id: digital.orderId },
        data: { status: "confirmed", paymentStatus: "paid" },
      });

      const other = await userWorld(h);
      const physical = await h.product({ price: 10_000 });
      const d2 = await digitalProduct(h, 20_000);
      await addTo(other, [{ variantId: physical.variantId }, { variantId: d2.variantId }]);
      const mixed = await h.checkout.place(other.owner, await mixedInput(other));
      const ids = (await listOrdersReadyToShip(h.tx, { limit: 1000 })).rows.map(
        (row) => row.orderId,
      );
      expect(ids).not.toContain(digital.orderId);
      expect(ids).toContain(mixed.orderId);
    });
  });

  it("AWB-ul (prin curier sau manual) e refuzat cu SHIPMENT_DIGITAL_ONLY; nu se creează nicio expediere", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const d = await digitalProduct(h);
      await addTo(world, [{ variantId: d.variantId }]);
      const placed = await h.checkout.place(
        world.owner,
        await digitalOnlyInput(world, { paymentMethod: "bank_transfer" }),
      );
      await h.tx.order.update({
        where: { id: placed.orderId },
        data: { status: "confirmed", paymentStatus: "paid" },
      });
      expect(
        await codeOf(createCarrierShipment(h.tx, placed.orderId, { ...ACTOR, carrier: demo() })),
      ).toBe("SHIPMENT_DIGITAL_ONLY");
      expect(
        await codeOf(
          createManualShipment(h.tx, placed.orderId, {
            ...ACTOR,
            carrier: "Transport SRL",
            awb: "AWB-1",
          }),
        ),
      ).toBe("SHIPMENT_DIGITAL_ONLY");
      expect(await h.tx.shipment.count({ where: { orderId: placed.orderId } })).toBe(0);
      expect(await listOrderShipments(h.tx, placed.orderId)).toHaveLength(0);
      const order = await orderOf(h.tx, placed.orderId);
      expect(order.shippingMethodCode).toBe("digital");
      expect(order.fulfillmentStatus).toBe("unfulfilled");
    });
  });

  it("comanda mixtă se expediază normal: AWB pentru partea fizică, cu rambursul pe totalul comenzii", async () => {
    await harness(async (h) => {
      const world = await userWorld(h);
      const physical = await h.product({ price: 10_000 });
      const d = await digitalProduct(h, 20_000);
      await addTo(world, [{ variantId: physical.variantId }, { variantId: d.variantId }]);
      const placed = await h.checkout.place(world.owner, await mixedInput(world));
      const result = await createCarrierShipment(h.tx, placed.orderId, {
        ...ACTOR,
        carrier: demo(),
      });
      expect(result.awb).toBeTruthy();
      const [shipment] = await listOrderShipments(h.tx, placed.orderId);
      expect(shipment).toMatchObject({ mode: "provider", status: "created" });
    });
  });
});
