import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DemoCarrier } from "@ecom/integrations";
import type { CarrierTracking, ShippingCarrier } from "@ecom/shared";
import { cancelOrder } from "../orders/order-actions";
import { NOW, codeOf, harness, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import { listOrdersReadyToShip } from "./ready-to-ship";
import {
  applyTrackingUpdate,
  cancelShipment,
  createCarrierReturn,
  createCarrierShipment,
  createCarrierShipmentsBulk,
  createManualReturn,
  createManualShipment,
  getShipmentLabel,
  listOrderShipments,
  markShipmentDelivered,
  syncShipmentStatuses,
} from "./shipment-service";

/**
 * Expedierile pe Postgres real, în tranzacție anulată: AWB manual (paletizat), AWB prin curier (DEMO simulat), anulare, retur,
 * urmărire idempotentă, emailurile «expediată» și «livrată» o singură dată, curier picat ≠ comandă pierdută.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const ACTOR = { actorLabel: "admin@test.ro", now: NOW };
const ENV = { E2E_HARNESS: "1" };
const demo = (now: Date = NOW) => new DemoCarrier({ env: ENV, now: () => now });
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

async function place(h: Harness, over: Record<string, unknown> = {}, productOver = {}) {
  const product = await h.product(productOver);
  const owner = await h.fill([{ variantId: product.variantId }]);
  const result = await h.checkout.place(owner, await h.input(owner, over));
  return result.orderId;
}

const shippedMails = (h: Harness, orderId: string, template: string) =>
  h.tx.emailDispatch.count({ where: { orderId, template, audience: "customer" } });

describe("AWB manual (transport paletizat)", () => {
  it("comandă paletizată cu ramburs: AWB manual → «expediată», eveniment cu AWB, un singur email", async () => {
    await harness(async (h) => {
      const orderId = await place(h, { shippingOfferCode: "pallet" }, { shippingClass: "pallet" });
      const order = await orderOf(h.tx, orderId);
      expect(order.shippingMethodCode).toBe("pallet");
      expect((order.shippingSnapshot as { kind: string }).kind).toBe("pallet");
      expect(order.paymentMethod).toBe("cod");

      const result = await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Transport Palet SRL",
        awb: "PAL-0001",
        trackingUrl: "https://urmarire.exemplu.ro/PAL-0001",
      });
      const after = await orderOf(h.tx, orderId);
      expect(after.fulfillmentStatus).toBe("in_transit");
      const types = after.events.map((e) => e.type);
      expect(types).toContain("shipment.created");
      expect(types).toContain("order.shipped");
      const shipped = after.events.find((e) => e.type === "order.shipped");
      expect(shipped?.data).toMatchObject({ awb: "PAL-0001", carrier: "Transport Palet SRL" });
      expect(shipped?.actorLabel).toBe("admin@test.ro");
      expect(await shippedMails(h, orderId, "order.shipped")).toBe(1);

      const [shipment] = await listOrderShipments(h.tx, orderId);
      expect(shipment).toMatchObject({
        id: result.shipmentId,
        mode: "manual",
        provider: null,
        status: "in_transit",
        awb: "PAL-0001",
      });
    });
  });

  it("«livrată» marcată de admin: `order.delivered` și emailul, o singură dată (idempotent)", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Transportator",
        awb: "M-1",
      });
      expect(await markShipmentDelivered(h.tx, shipmentId, ACTOR)).toEqual({
        alreadyDelivered: false,
      });
      expect(await markShipmentDelivered(h.tx, shipmentId, ACTOR)).toEqual({
        alreadyDelivered: true,
      });
      const order = await orderOf(h.tx, orderId);
      expect(order.fulfillmentStatus).toBe("delivered");
      expect(order.events.filter((e) => e.type === "order.delivered")).toHaveLength(1);
      expect(await shippedMails(h, orderId, "order.delivered")).toBe(1);
    });
  });

  it("date invalide: transportator sau AWB prea scurt, link nu http(s)", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      for (const bad of [
        { carrier: "A", awb: "X-1" },
        { carrier: "Transportator", awb: "1" },
        { carrier: "Transportator", awb: "X-1", trackingUrl: "javascript:alert(1)" },
        { carrier: "Transportator", awb: "X-1", trackingUrl: "nu e adresa" },
      ]) {
        expect(await codeOf(createManualShipment(h.tx, orderId, { ...ACTOR, ...bad }))).toBe(
          "SHIPMENT_INVALID",
        );
      }
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("unfulfilled");
    });
  });

  it("a doua expediere pe aceeași comandă: refuzată; o comandă anulată: refuzată", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      await createManualShipment(h.tx, orderId, { ...ACTOR, carrier: "T1", awb: "A-1" });
      expect(
        await codeOf(createManualShipment(h.tx, orderId, { ...ACTOR, carrier: "T2", awb: "A-2" })),
      ).toBe("SHIPMENT_ORDER_STATE");
      const other = await place(h);
      await cancelOrder(h.tx, other, { reason: "test anulare", ...ACTOR });
      expect(
        await codeOf(
          createManualShipment(h.tx, other, { ...ACTOR, carrier: "Transp", awb: "B-1" }),
        ),
      ).toBe("SHIPMENT_ORDER_STATE");
    });
  });

  it("comanda cu ridicare personală nu primește AWB și nu are destinație de livrare", async () => {
    await harness(async (h) => {
      const orderId = await place(h, { shippingOfferCode: "pickup" });
      expect((await orderOf(h.tx, orderId)).shippingMethodCode).toBe("pickup");
      expect(
        await codeOf(
          createManualShipment(h.tx, orderId, { ...ACTOR, carrier: "Transp", awb: "P-1" }),
        ),
      ).toBe("SHIPMENT_PICKUP");
      expect(
        await codeOf(createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: demo() })),
      ).toBe("SHIPMENT_PICKUP");
      expect(await h.tx.shipment.count({ where: { orderId } })).toBe(0);
    });
  });
});

describe("reguli de stare", () => {
  it("o comandă încă neplătită (transfer bancar în așteptare) nu se expediază", async () => {
    await harness(async (h) => {
      const orderId = await place(h, { paymentMethod: "bank_transfer" });
      expect((await orderOf(h.tx, orderId)).status).toBe("pending");
      expect(
        await codeOf(
          createManualShipment(h.tx, orderId, { ...ACTOR, carrier: "Transp", awb: "N-1" }),
        ),
      ).toBe("SHIPMENT_ORDER_STATE");
      expect(
        await codeOf(createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: demo() })),
      ).toBe("SHIPMENT_ORDER_STATE");
    });
  });

  it("o comandă returnată nu se «re-livrează»: marcarea livrată nu aruncă și nu schimbă starea", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Transp",
        awb: "RT-1",
      });
      await h.tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: "returned" } });
      await markShipmentDelivered(h.tx, shipmentId, ACTOR);
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("returned");
    });
  });
});

describe("AWB prin curier (DEMO simulat)", () => {
  it("creează AWB cu rambursul comenzii, comanda devine «pregătită», fără email «expediată» încă", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const order = await orderOf(h.tx, orderId);
      const result = await createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: demo() });
      const [shipment] = await listOrderShipments(h.tx, orderId);
      expect(shipment).toMatchObject({
        mode: "provider",
        provider: "demo",
        status: "created",
        awb: result.awb,
        // rambursul transmis curierului = totalul comenzii (plata e ramburs, încă neîncasată)
        codAmountMinor: order.totalMinor,
      });
      const after = await orderOf(h.tx, orderId);
      expect(after.fulfillmentStatus).toBe("fulfilled");
      expect(await shippedMails(h, orderId, "order.shipped")).toBe(0);
    });
  });

  it("o comandă deja plătită cu cardul pleacă fără ramburs", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      await h.tx.order.update({ where: { id: orderId }, data: { paymentStatus: "paid" } });
      await createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: demo() });
      const [shipment] = await listOrderShipments(h.tx, orderId);
      expect(shipment?.codAmountMinor).toBe(0);
    });
  });

  it("transportul paletizat nu se expediază prin API, doar manual", async () => {
    await harness(async (h) => {
      const orderId = await place(h, { shippingOfferCode: "pallet" }, { shippingClass: "pallet" });
      expect(
        await codeOf(createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: demo() })),
      ).toBe("SHIPMENT_PALLET_MANUAL_ONLY");
    });
  });

  it("curier picat: comanda rămâne neexpediată, fără expediere scrisă; apoi merge manual", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const down = {
        ...demo(),
        code: "demo",
        label: "DEMO",
        createAwb: async () => {
          throw Object.assign(new Error("jos"), { code: "SHIPPING_PROVIDER_UNREACHABLE" });
        },
        quote: async () => [],
      } as unknown as ShippingCarrier;
      await expect(
        createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: down }),
      ).rejects.toThrow();
      expect(await h.tx.shipment.count({ where: { orderId } })).toBe(0);
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("unfulfilled");
      await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Curier propriu",
        awb: "M-9",
      });
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("in_transit");
    });
  });

  it("compensare: dacă între timp s-a creat altă expediere, AWB-ul tocmai creat se anulează la curier", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const cancelled: string[] = [];
      const racing = new DemoCarrier({ env: ENV, now: () => NOW });
      const wrapped = {
        code: "demo",
        label: "DEMO",
        quote: racing.quote.bind(racing),
        createAwb: async (request: Parameters<DemoCarrier["createAwb"]>[0]) => {
          const created = await racing.createAwb(request);
          // altă cerere a expediat comanda cât timp noi vorbeam cu curierul
          await createManualShipment(h.tx, orderId, { ...ACTOR, carrier: "Concurent", awb: "C-1" });
          return created;
        },
        cancel: async (ref: { awb: string }) => {
          cancelled.push(ref.awb);
        },
      } as unknown as ShippingCarrier;
      const outcome = await codeOf(
        createCarrierShipment(h.tx, orderId, { ...ACTOR, carrier: wrapped }),
      );
      expect(["SHIPMENT_ORDER_STATE", "SHIPMENT_EXISTS"]).toContain(outcome);
      expect(cancelled).toHaveLength(1);
      expect(await h.tx.shipment.count({ where: { orderId, status: { not: "cancelled" } } })).toBe(
        1,
      );
    });
  });

  it("în masă: fiecare comandă independent, cu cod stabil la eroare", async () => {
    await harness(async (h) => {
      const a = await place(h);
      const b = await place(h, { shippingOfferCode: "pickup" });
      const outcomes = await createCarrierShipmentsBulk(h.tx, [a, b, a], {
        ...ACTOR,
        carrier: demo(),
      });
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({ orderId: a, ok: true });
      expect(outcomes[1]).toMatchObject({ orderId: b, ok: false, code: "SHIPMENT_PICKUP" });
    });
  });

  it("eticheta PDF și ZPL a unui AWB DEMO; o expediere manuală nu are etichetă", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createCarrierShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: demo(),
      });
      const pdf = await getShipmentLabel(h.tx, demo(), shipmentId, "pdf");
      expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe("%PDF-");
      const zpl = await getShipmentLabel(h.tx, demo(), shipmentId, "zpl");
      expect(Buffer.from(zpl.bytes).toString()).toContain("^XA");
      const manual = await place(h);
      const m = await createManualShipment(h.tx, manual, {
        ...ACTOR,
        carrier: "Transp",
        awb: "L-1",
      });
      expect(await codeOf(getShipmentLabel(h.tx, demo(), m.shipmentId, "pdf"))).toBe(
        "SHIPMENT_INVALID",
      );
    });
  });
});

describe("urmărirea: idempotentă, monotonă, emailuri o singură dată", () => {
  async function tracked(h: Harness) {
    const orderId = await place(h);
    const { shipmentId, awb } = await createCarrierShipment(h.tx, orderId, {
      ...ACTOR,
      carrier: demo(),
    });
    const track = (seconds: number): Promise<CarrierTracking> =>
      demo(at(seconds)).track({ awb, providerRef: awb });
    return { orderId, shipmentId, track };
  }

  it("ridicat → în tranzit → livrat: un `order.shipped` și un `order.delivered`, chiar dacă același istoric vine de două ori", async () => {
    await harness(async (h) => {
      const { orderId, shipmentId, track } = await tracked(h);
      const first = await applyTrackingUpdate(h.tx, shipmentId, await track(130), at(130));
      expect(first).toMatchObject({ changed: true, status: "picked_up" });
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("in_transit");
      // același istoric, a doua oară: nimic nou
      const again = await applyTrackingUpdate(h.tx, shipmentId, await track(130), at(131));
      expect(again).toMatchObject({ changed: false, newEvents: 0 });
      await applyTrackingUpdate(h.tx, shipmentId, await track(320), at(320));
      await applyTrackingUpdate(h.tx, shipmentId, await track(700), at(700));
      await applyTrackingUpdate(h.tx, shipmentId, await track(700), at(701));
      const order = await orderOf(h.tx, orderId);
      expect(order.fulfillmentStatus).toBe("delivered");
      expect(order.events.filter((e) => e.type === "order.shipped")).toHaveLength(1);
      expect(order.events.filter((e) => e.type === "order.delivered")).toHaveLength(1);
      expect(await shippedMails(h, orderId, "order.shipped")).toBe(1);
      expect(await shippedMails(h, orderId, "order.delivered")).toBe(1);
      const [shipment] = await listOrderShipments(h.tx, orderId);
      expect(shipment?.events.map((e) => e.code)).toEqual([
        "created",
        "picked_up",
        "in_transit",
        "delivered",
      ]);
      expect(shipment?.deliveredAt).not.toBeNull();
    });
  });

  it("starea nu coboară: un istoric mai vechi nu readuce un colet livrat în tranzit", async () => {
    await harness(async (h) => {
      const { shipmentId, track } = await tracked(h);
      await applyTrackingUpdate(h.tx, shipmentId, await track(700), at(700));
      const stale = await applyTrackingUpdate(h.tx, shipmentId, await track(130), at(800));
      expect(stale).toMatchObject({ changed: false, status: "delivered" });
    });
  });

  it("un istoric mai vechi nu coboară nici un colet în tranzit (în tranzit → ridicat)", async () => {
    await harness(async (h) => {
      const { shipmentId, track } = await tracked(h);
      await applyTrackingUpdate(h.tx, shipmentId, await track(320), at(320));
      const stale = await applyTrackingUpdate(h.tx, shipmentId, await track(130), at(330));
      expect(stale).toMatchObject({ changed: false, status: "in_transit" });
    });
  });

  it("curierul raportează «retur» sau «anulat»: comanda urmează", async () => {
    await harness(async (h) => {
      const { orderId, shipmentId } = await tracked(h);
      await applyTrackingUpdate(h.tx, shipmentId, { status: "in_transit", events: [] }, at(10));
      await applyTrackingUpdate(h.tx, shipmentId, { status: "returned", events: [] }, at(20));
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("returned");
    });
    await harness(async (h) => {
      const { orderId, shipmentId } = await tracked(h);
      await applyTrackingUpdate(h.tx, shipmentId, { status: "cancelled", events: [] }, at(20));
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("unfulfilled");
    });
  });

  it("sincronizarea: o expediere a cărei urmărire eșuează nu le oprește pe celelalte", async () => {
    await harness(async (h) => {
      const a = await tracked(h);
      const b = await tracked(h);
      const flaky = {
        track: async (ref: { awb: string; providerRef: string | null }) => {
          const real = demo(at(700));
          const target = await h.tx.shipment.findUniqueOrThrow({ where: { id: b.shipmentId } });
          if (ref.awb === target.awb) throw new Error("curier picat");
          return real.track(ref);
        },
      } as unknown as ShippingCarrier;
      const result = await syncShipmentStatuses(h.tx, async () => flaky, { now: at(700) });
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.changed).toBeGreaterThanOrEqual(1);
      expect((await orderOf(h.tx, a.orderId)).fulfillmentStatus).toBe("delivered");
      expect((await orderOf(h.tx, b.orderId)).fulfillmentStatus).toBe("fulfilled");
      // la rularea următoare, cu curierul înapoi, se recuperează
      await syncShipmentStatuses(h.tx, async () => demo(at(700)), { now: at(800) });
      expect((await orderOf(h.tx, b.orderId)).fulfillmentStatus).toBe("delivered");
    });
  });

  it("sincronizarea nu atinge expedierile manuale și nici pe cele fără curier configurat", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      await createManualShipment(h.tx, orderId, { ...ACTOR, carrier: "Transp", awb: "S-1" });
      const none = await syncShipmentStatuses(h.tx, async () => null, { now: at(10) });
      expect(none.checked).toBe(0);
    });
  });
});

describe("anulare și retur", () => {
  it("AWB anulat înainte de livrare: comanda revine la «neexpediată» și se poate expedia din nou", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createCarrierShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: demo(),
      });
      expect(await cancelShipment(h.tx, shipmentId, { ...ACTOR, carrier: demo() })).toEqual({
        alreadyCancelled: false,
      });
      expect(await cancelShipment(h.tx, shipmentId, { ...ACTOR, carrier: demo() })).toEqual({
        alreadyCancelled: true,
      });
      const order = await orderOf(h.tx, orderId);
      expect(order.fulfillmentStatus).toBe("unfulfilled");
      expect(order.events.filter((e) => e.type === "shipment.cancelled")).toHaveLength(1);
      await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Curier propriu",
        awb: "R-1",
      });
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("in_transit");
    });
  });

  it("curierul refuză anularea: nu se schimbă nimic la noi", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createCarrierShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: demo(),
      });
      const refusing = {
        code: "demo",
        label: "DEMO",
        cancel: async () => {
          throw new Error("nu mai poate fi anulat");
        },
      } as unknown as ShippingCarrier;
      await expect(
        cancelShipment(h.tx, shipmentId, { ...ACTOR, carrier: refusing }),
      ).rejects.toThrow();
      expect((await listOrderShipments(h.tx, orderId))[0]?.status).toBe("created");
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("fulfilled");
    });
  });

  it("o expediere livrată nu se mai anulează", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Transp",
        awb: "D-1",
      });
      await markShipmentDelivered(h.tx, shipmentId, ACTOR);
      expect(await codeOf(cancelShipment(h.tx, shipmentId, { ...ACTOR, carrier: null }))).toBe(
        "SHIPMENT_CANNOT_CANCEL",
      );
    });
  });

  it("AWB de retur: doar după livrare, un singur retur activ; manual, când curierul nu-l oferă", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createCarrierShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: demo(),
      });
      expect(
        await codeOf(createCarrierReturn(h.tx, shipmentId, { ...ACTOR, carrier: demo() })),
      ).toBe("SHIPMENT_NOT_DELIVERED");
      await markShipmentDelivered(h.tx, shipmentId, ACTOR);
      const ret = await createCarrierReturn(h.tx, shipmentId, { ...ACTOR, carrier: demo() });
      expect(ret.awb).toMatch(/^DEMO/);
      expect(
        await codeOf(
          createManualReturn(h.tx, shipmentId, { ...ACTOR, carrier: "Transp", awb: "RET-1" }),
        ),
      ).toBe("SHIPMENT_EXISTS");
      const all = await listOrderShipments(h.tx, orderId);
      expect(all.map((s) => s.kind)).toEqual(["outbound", "return"]);
      expect(all[1]?.parentId).toBe(shipmentId);
      // returul nu schimbă starea de livrare a comenzii
      expect((await orderOf(h.tx, orderId)).fulfillmentStatus).toBe("delivered");
    });
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createManualShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: "Transp",
        awb: "O-1",
      });
      await markShipmentDelivered(h.tx, shipmentId, ACTOR);
      const ret = await createManualReturn(h.tx, shipmentId, {
        ...ACTOR,
        carrier: "Retur SRL",
        awb: "RET-9",
      });
      expect(ret.awb).toBe("RET-9");
    });
  });
});

describe("comenzile de expediat în masă", () => {
  it("doar confirmate, neexpediate, cu livrare la adresă prin curier; fără ridicare, paletizat, expediate sau neconfirmate", async () => {
    await harness(async (h) => {
      const ready = await place(h);
      const pickup = await place(h, { shippingOfferCode: "pickup" });
      const pallet = await place(h, { shippingOfferCode: "pallet" }, { shippingClass: "pallet" });
      const bank = await place(h, { paymentMethod: "bank_transfer" });
      const shippedAlready = await place(h);
      await createManualShipment(h.tx, shippedAlready, {
        ...ACTOR,
        carrier: "Transp",
        awb: "RTS-1",
      });
      const { rows } = await listOrdersReadyToShip(h.tx, { limit: 500 });
      const ids = rows.map((r) => r.orderId);
      expect(ids).toContain(ready);
      for (const excluded of [pickup, pallet, bank, shippedAlready])
        expect(ids).not.toContain(excluded);
      const row = rows.find((r) => r.orderId === ready);
      expect(row).toMatchObject({ paymentMethod: "cod", countyName: expect.any(String) });
    });
  });

  it("după anularea AWB-ului comanda reapare în listă", async () => {
    await harness(async (h) => {
      const orderId = await place(h);
      const { shipmentId } = await createCarrierShipment(h.tx, orderId, {
        ...ACTOR,
        carrier: demo(),
      });
      expect(
        (await listOrdersReadyToShip(h.tx, { limit: 500 })).rows.map((r) => r.orderId),
      ).not.toContain(orderId);
      await cancelShipment(h.tx, shipmentId, { ...ACTOR, carrier: demo() });
      expect(
        (await listOrdersReadyToShip(h.tx, { limit: 500 })).rows.map((r) => r.orderId),
      ).toContain(orderId);
    });
  });
});
