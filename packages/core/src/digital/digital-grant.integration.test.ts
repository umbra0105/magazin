import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DIGITAL_PORTS, addOrderEvent, transitionOrder } from "../orders/order-service";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { digitalFixture, type DigitalFixture } from "../test-utils/digital-fixtures";
import { DIGITAL_LINE_REFUND_KEY_PREFIX, scheduleDigitalAccess } from "./digital-grant";

/**
 * Faza 14b, acordarea și retragerea accesului legate de evenimentele comenzii (decizia 1). Fiecare test pornește de la o comandă
 * creată în tranzacția lui (anulată la sfârșit) și o duce prin tranzițiile REALE (`transitionOrder`, deci prin `addOrderEvent` și
 * cârligul din el).
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const NOW = new Date();

async function entitlementsOf(tx: TestTx, orderId: string) {
  return tx.digitalEntitlement.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

async function eventsOf(tx: TestTx, orderId: string, type: string) {
  return tx.orderEvent.count({ where: { orderId, type } });
}

const pay = (tx: TestTx, f: DigitalFixture) =>
  transitionOrder(
    tx,
    f.orderId,
    { status: "confirmed", paymentStatus: "paid" },
    { type: "payment.confirmed", message: "Plata a fost confirmată" },
    NOW,
  );

const advanceTo = async (
  tx: TestTx,
  f: DigitalFixture,
  target: "fulfilled" | "in_transit" | "delivered",
) => {
  const path = ["fulfilled", "in_transit", "delivered"] as const;
  for (const step of path) {
    await transitionOrder(
      tx,
      f.orderId,
      { fulfillmentStatus: step },
      {
        type:
          step === "fulfilled"
            ? "shipment.created"
            : step === "in_transit"
              ? "order.shipped"
              : "order.delivered",
        message: step,
      },
      NOW,
    );
    if (step === target) return;
  }
};

describe("card și transfer bancar: acces la plata confirmată", () => {
  it.each(["card", "bank_transfer"] as const)(
    "%s: nimic înainte de plată, drept de acces după (cu limita din produs și jeton opac)",
    async (paymentMethod) => {
      await inRolledBackTransaction(db, async (tx) => {
        const f = await digitalFixture(tx, { paymentMethod, maxDownloads: 3 });
        await addOrderEvent(tx, f.orderId, { type: "order.placed", message: "plasată" });
        expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);

        await pay(tx, f);
        const rows = await entitlementsOf(tx, f.orderId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          orderLineId: f.digitalLineIds[0],
          customerId: f.userId,
          productId: f.digitalProductIds[0],
          grantReason: "payment",
          maxDownloads: 3,
          downloadCount: 0,
          revokedAt: null,
        });
        expect(rows[0]?.accessToken.length).toBeGreaterThanOrEqual(32);
        expect(await eventsOf(tx, f.orderId, "digital.granted")).toBe(1);
      });
    },
  );

  it("comandă cu mai multe linii digitale: un drept pe linie, un singur eveniment", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 3 });
      await pay(tx, f);
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(3);
      expect(await eventsOf(tx, f.orderId, "digital.granted")).toBe(1);
    });
  });

  it("comandă mixtă cu card: digitalul se acordă la plată, fără să atingă livrarea fizicului", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "card", physicalLines: 1 });
      await pay(tx, f);
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(1);
      const order = await tx.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(order.fulfillmentStatus).toBe("unfulfilled");
    });
  });

  it("plata eșuată sau anulată nu acordă nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "card" });
      await transitionOrder(
        tx,
        f.orderId,
        { paymentStatus: "failed" },
        { type: "payment.failed", message: "Plata a eșuat" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);
    });
  });
});

describe("starea de livrare a comenzii la acordarea accesului", () => {
  it("comanda 100% digitală trece în «fulfilled» la acordare, cu evenimentul digital.fulfilled, o singură dată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 2 });
      await pay(tx, f);
      const order = await tx.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(order.fulfillmentStatus).toBe("fulfilled");
      expect(await eventsOf(tx, f.orderId, "digital.fulfilled")).toBe(1);
      await addOrderEvent(tx, f.orderId, { type: "payment.confirmed", message: "încă o dată" });
      expect(await eventsOf(tx, f.orderId, "digital.fulfilled")).toBe(1);
    });
  });

  it("comanda MIXTĂ cu card: starea de livrare rămâne «unfulfilled» (a părții fizice), fără partially_fulfilled", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "card", physicalLines: 1 });
      await pay(tx, f);
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(1);
      const order = await tx.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(order.fulfillmentStatus).toBe("unfulfilled");
      expect(await eventsOf(tx, f.orderId, "digital.fulfilled")).toBe(0);
    });
  });

  it("la ramburs mixt, livrarea confirmată acordă accesul fără să schimbe starea de livrare setată de expediere", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "cod", physicalLines: 1 });
      await transitionOrder(
        tx,
        f.orderId,
        { status: "confirmed" },
        { type: "order.confirmed", message: "confirmată" },
        NOW,
      );
      await advanceTo(tx, f, "delivered");
      const order = await tx.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(order.fulfillmentStatus).toBe("delivered");
      expect(await eventsOf(tx, f.orderId, "digital.fulfilled")).toBe(0);
    });
  });
});

describe("ramburs în comandă mixtă: acces abia la livrare confirmată (decizia 1)", () => {
  it("nu la plasare, nu la confirmare, nu la expediere, nici la încasarea banilor; da la livrare", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "cod", physicalLines: 1 });
      await addOrderEvent(tx, f.orderId, { type: "order.placed", message: "plasată" });
      await transitionOrder(
        tx,
        f.orderId,
        { status: "confirmed" },
        { type: "order.confirmed", message: "confirmată" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);

      await advanceTo(tx, f, "in_transit");
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);

      // curierul a virat banii ÎNAINTE de livrarea marcată: tot fără acces
      await transitionOrder(
        tx,
        f.orderId,
        { paymentStatus: "paid" },
        { type: "payment.cod_collected", message: "Rambursul a fost încasat" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);

      await transitionOrder(
        tx,
        f.orderId,
        { fulfillmentStatus: "delivered" },
        { type: "order.delivered", message: "livrată" },
        NOW,
      );
      const rows = await entitlementsOf(tx, f.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ grantReason: "delivery", customerId: f.userId });
    });
  });

  it("ridicarea personală marcată «ridicată» acordă accesul (evenimentul order.picked_up)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "cod", physicalLines: 1 });
      await transitionOrder(
        tx,
        f.orderId,
        { status: "confirmed", fulfillmentStatus: "fulfilled" },
        { type: "fulfillment.step", message: "pregătită" },
        NOW,
      );
      await transitionOrder(
        tx,
        f.orderId,
        { fulfillmentStatus: "in_transit" },
        { type: "fulfillment.step", message: "pregătită" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);
      await transitionOrder(
        tx,
        f.orderId,
        { fulfillmentStatus: "delivered" },
        { type: "order.picked_up", message: "ridicată" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(1);
    });
  });

  it("returnată la expeditor (nelivrată) nu primește acces", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { paymentMethod: "cod", physicalLines: 1 });
      await transitionOrder(
        tx,
        f.orderId,
        { status: "confirmed" },
        { type: "order.confirmed", message: "confirmată" },
        NOW,
      );
      await advanceTo(tx, f, "in_transit");
      await transitionOrder(
        tx,
        f.orderId,
        { fulfillmentStatus: "returned" },
        { type: "order.returned_to_sender", message: "întoarsă" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);
    });
  });
});

describe("idempotență și cazuri limită", () => {
  it("același eveniment procesat de două ori nu dublează dreptul și nu dublează evenimentul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 2 });
      await pay(tx, f);
      await scheduleDigitalAccess(
        tx,
        f.orderId,
        { id: "e1", type: "payment.confirmed" },
        DIGITAL_PORTS,
      );
      await scheduleDigitalAccess(
        tx,
        f.orderId,
        { id: "e1", type: "payment.confirmed" },
        DIGITAL_PORTS,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(2);
      expect(await eventsOf(tx, f.orderId, "digital.granted")).toBe(1);
    });
  });

  it("un eveniment fără legătură cu accesul nu face nimic, nici măcar după plată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      await transitionOrder(
        tx,
        f.orderId,
        { status: "confirmed", paymentStatus: "paid" },
        { type: "payment.attention", message: "ceva" },
        NOW,
      );
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);
    });
  });

  it("comandă fără cont de client: nu se acordă nimic, se scrie evenimentul digital.grant_blocked o singură dată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { guest: true });
      await pay(tx, f);
      await addOrderEvent(tx, f.orderId, { type: "order.delivered", message: "livrată" });
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);
      expect(await eventsOf(tx, f.orderId, "digital.grant_blocked")).toBe(1);
    });
  });

  it("o comandă fără linii digitale nu primește nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 0, physicalLines: 1 });
      await pay(tx, f);
      expect(await entitlementsOf(tx, f.orderId)).toHaveLength(0);
      expect(await tx.digitalEntitlement.count()).toBe(
        await tx.digitalEntitlement.count({ where: { NOT: { orderId: f.orderId } } }),
      );
    });
  });
});

describe("retragerea accesului", () => {
  it("rambursare integrală: tot accesul comenzii e retras, cu motiv; evenimentul se scrie o singură dată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 2 });
      await pay(tx, f);
      await transitionOrder(
        tx,
        f.orderId,
        { paymentStatus: "refunded" },
        { type: "payment.refunded", message: "Rambursată integral" },
        NOW,
      );
      const rows = await entitlementsOf(tx, f.orderId);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(rows[0]?.revokedReason).toBe("Comanda a fost rambursată integral");
      expect(await eventsOf(tx, f.orderId, "digital.revoked")).toBe(1);
    });
  });

  it("rambursare parțială fără cheie de linie: nimic nu se retrage", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 2 });
      await pay(tx, f);
      await transitionOrder(
        tx,
        f.orderId,
        { paymentStatus: "partially_refunded" },
        { type: "payment.refunded", message: "Rambursată parțial" },
        NOW,
      );
      const rows = await entitlementsOf(tx, f.orderId);
      expect(rows.every((r) => r.revokedAt === null)).toBe(true);
    });
  });

  it("rambursarea unei linii (cheia digital-line) retrage DOAR acea linie; a doua apelare nu schimbă nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx, { digitalLines: 2 });
      await pay(tx, f);
      const payment = await tx.payment.create({
        data: {
          orderId: f.orderId,
          provider: "demo",
          method: "card",
          amountMinor: 20_000,
          status: "paid",
          capturedAt: new Date(),
          attemptNo: 1,
          mode: "demo",
        },
      });
      const refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: f.orderId,
          amountMinor: 10_000,
          reason: "Rambursare linie digitală",
          kind: "admin",
          status: "confirmed",
          confirmedAt: new Date(),
          idempotencyKey: `${DIGITAL_LINE_REFUND_KEY_PREFIX}${f.digitalLineIds[0]}:${randomUUID().slice(0, 6)}`,
        },
      });
      const event = {
        type: "payment.refunded",
        message: "Rambursată parțial",
        data: { refundId: refund.id, amountMinor: 10_000 },
      };
      await transitionOrder(tx, f.orderId, { paymentStatus: "partially_refunded" }, event, NOW);
      const rows = await entitlementsOf(tx, f.orderId);
      const byLine = new Map(rows.map((r) => [r.orderLineId, r]));
      expect(byLine.get(f.digitalLineIds[0] as string)?.revokedAt).not.toBeNull();
      expect(byLine.get(f.digitalLineIds[1] as string)?.revokedAt).toBeNull();

      await addOrderEvent(tx, f.orderId, event);
      expect(await eventsOf(tx, f.orderId, "digital.revoked")).toBe(1);
    });
  });

  it("o rambursare cu cheie de linie încă neconfirmată nu retrage nimic (evenimentul vine la confirmare)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      await pay(tx, f);
      const payment = await tx.payment.create({
        data: {
          orderId: f.orderId,
          provider: "demo",
          method: "card",
          amountMinor: 10_000,
          status: "paid",
          capturedAt: new Date(),
          attemptNo: 1,
          mode: "demo",
        },
      });
      const refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: f.orderId,
          amountMinor: 10_000,
          reason: "Rambursare linie",
          kind: "admin",
          status: "requested",
          idempotencyKey: `${DIGITAL_LINE_REFUND_KEY_PREFIX}${f.digitalLineIds[0]}:x`,
        },
      });
      await addOrderEvent(tx, f.orderId, {
        type: "payment.refunded",
        message: "?",
        data: { refundId: refund.id },
      });
      const rows = await entitlementsOf(tx, f.orderId);
      expect(rows.every((r) => r.revokedAt === null)).toBe(true);
    });
  });

  it("o rambursare cu cheie de linie a ALTEI comenzi nu atinge această comandă", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await digitalFixture(tx);
      const b = await digitalFixture(tx);
      await pay(tx, a);
      await pay(tx, b);
      const payment = await tx.payment.create({
        data: {
          orderId: b.orderId,
          provider: "demo",
          method: "card",
          amountMinor: 10_000,
          status: "paid",
          capturedAt: new Date(),
          attemptNo: 1,
          mode: "demo",
        },
      });
      const refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: b.orderId,
          amountMinor: 10_000,
          reason: "Rambursare linie",
          kind: "admin",
          status: "confirmed",
          confirmedAt: new Date(),
          // cheia numește linia comenzii A, dar rambursarea e a comenzii B
          idempotencyKey: `${DIGITAL_LINE_REFUND_KEY_PREFIX}${a.digitalLineIds[0]}:x`,
        },
      });
      await addOrderEvent(tx, b.orderId, {
        type: "payment.refunded",
        message: "?",
        data: { refundId: refund.id },
      });
      expect((await entitlementsOf(tx, a.orderId)).every((r) => r.revokedAt === null)).toBe(true);
      expect((await entitlementsOf(tx, b.orderId)).every((r) => r.revokedAt === null)).toBe(true);
    });
  });

  it("anularea comenzii retrage accesul acordat", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      await pay(tx, f);
      await transitionOrder(
        tx,
        f.orderId,
        { status: "cancelled" },
        { type: "order.cancelled", message: "anulată" },
        NOW,
      );
      const rows = await entitlementsOf(tx, f.orderId);
      expect(rows[0]?.revokedAt).not.toBeNull();
      expect(rows[0]?.revokedReason).toBe("Comanda a fost anulată");
    });
  });

  it("un drept retras nu mai este acordat din nou de un eveniment ulterior de plată sau livrare", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const f = await digitalFixture(tx);
      await pay(tx, f);
      await transitionOrder(
        tx,
        f.orderId,
        { paymentStatus: "refunded" },
        { type: "payment.refunded", message: "rambursată" },
        NOW,
      );
      await addOrderEvent(tx, f.orderId, { type: "payment.confirmed", message: "încă o dată" });
      const rows = await entitlementsOf(tx, f.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).not.toBeNull();
    });
  });
});
