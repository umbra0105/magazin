import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 12, schema expedierilor (`shipment`, `shipment_event`). Fiecare constrângere are un test care o încalcă, iar CHECK-urile
 * compuse au și cazul «una setată, una nulă» (un CHECK cu rezultat NULL TRECE). Testele nu presupun date de seed: își creează
 * singure canalul și comanda, într-o tranzacție anulată.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function order(tx: TestTx) {
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  return tx.order.create({
    data: {
      number: `T-${uid()}`,
      channelId: channel.id,
      email: "client@exemplu.ro",
      phone: "0722000000",
      subtotalMinor: 10_000,
      shippingMinor: 0,
      taxMinor: 1_735,
      totalMinor: 10_000,
      taxRateBps: 2100,
      shippingMethodCode: "pallet",
      shippingSnapshot: { kind: "pallet" },
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
    },
  });
}

const shipmentData = (orderId: string, over: Record<string, unknown> = {}) => ({
  orderId,
  mode: "manual",
  carrier: "Transportator Test",
  awb: `AWB-${uid()}`,
  ...over,
});

async function attempt(act: (tx: TestTx, orderId: string) => Promise<unknown>) {
  return inRolledBackTransaction(db, async (tx) => {
    const o = await order(tx);
    try {
      await act(tx, o.id);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

async function rejects(act: (tx: TestTx, orderId: string) => Promise<unknown>, expected: string) {
  const error = await attempt(act);
  expect(error, `baza trebuia să respingă scrierea (${expected})`).not.toBeNull();
  expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

describe("expediere: valori permise", () => {
  it("o expediere manuală valabilă se scrie, cu valorile implicite", async () => {
    const error = await attempt(async (tx, orderId) => {
      const s = await tx.shipment.create({ data: shipmentData(orderId) });
      expect(s).toMatchObject({
        kind: "outbound",
        status: "created",
        codAmountMinor: 0,
        parcelCount: 1,
        provider: null,
      });
    });
    expect(error).toBeNull();
  });

  it("tip necunoscut: refuzat", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { kind: "altceva" }) }),
      "shipment_kind_check",
    );
  });

  it("stare necunoscută: refuzată", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { status: "pierdut" }) }),
      "shipment_status_check",
    );
  });

  it("AWB gol sau doar spații, transportator gol: refuzate", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { awb: "   " }) }),
      "shipment_awb_check",
    );
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { carrier: "" }) }),
      "shipment_awb_check",
    );
  });

  it("sume: ramburs negativ, zero colete, greutate negativă: refuzate", async () => {
    for (const over of [{ codAmountMinor: -1 }, { parcelCount: 0 }, { weightGrams: -5 }]) {
      await rejects(
        (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, over) }),
        "shipment_amounts_check",
      );
    }
  });
});

describe("expediere: modul și furnizorul (una setată, una nulă)", () => {
  it("manual CU furnizor: refuzat", async () => {
    await rejects(
      (tx, orderId) =>
        tx.shipment.create({
          data: shipmentData(orderId, { mode: "manual", provider: "sameday" }),
        }),
      "shipment_mode_check",
    );
  });
  it("prin furnizor FĂRĂ furnizor: refuzat", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { mode: "provider" }) }),
      "shipment_mode_check",
    );
  });
  it("prin furnizor necunoscut (cargus nu există): refuzat", async () => {
    await rejects(
      (tx, orderId) =>
        tx.shipment.create({
          data: shipmentData(orderId, { mode: "provider", provider: "cargus" }),
        }),
      "shipment_mode_check",
    );
  });
  it("prin furnizor valid: acceptat", async () => {
    for (const provider of ["wootpro", "sameday", "demo"]) {
      const error = await attempt((tx, orderId) =>
        tx.shipment.create({ data: shipmentData(orderId, { mode: "provider", provider }) }),
      );
      expect(error).toBeNull();
    }
  });
});

describe("expediere: returul și părintele (una setată, una nulă)", () => {
  it("retur FĂRĂ părinte: refuzat", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { kind: "return" }) }),
      "shipment_parent_check",
    );
  });
  it("expediere la client CU părinte: refuzată", async () => {
    await rejects(async (tx, orderId) => {
      const parent = await tx.shipment.create({ data: shipmentData(orderId) });
      await tx.shipment.create({ data: shipmentData(orderId, { parentId: parent.id }) });
    }, "shipment_parent_check");
  });
  it("al doilea retur neanulat pe același părinte: refuzat", async () => {
    await rejects(async (tx, orderId) => {
      const parent = await tx.shipment.create({ data: shipmentData(orderId) });
      await tx.shipment.create({
        data: shipmentData(orderId, { kind: "return", parentId: parent.id }),
      });
      await tx.shipment.create({
        data: shipmentData(orderId, { kind: "return", parentId: parent.id }),
      });
    }, "shipment_one_active_return");
  });
  it("un retur anulat nu blochează un retur nou", async () => {
    const error = await attempt(async (tx, orderId) => {
      const parent = await tx.shipment.create({ data: shipmentData(orderId) });
      await tx.shipment.create({
        data: shipmentData(orderId, {
          kind: "return",
          parentId: parent.id,
          status: "cancelled",
          cancelledAt: new Date(),
        }),
      });
      await tx.shipment.create({
        data: shipmentData(orderId, { kind: "return", parentId: parent.id }),
      });
    });
    expect(error).toBeNull();
  });
});

describe("expediere: livrare și anulare (una setată, una nulă)", () => {
  it("«livrată» fără momentul livrării: refuzată", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { status: "delivered" }) }),
      "shipment_delivered_check",
    );
  });
  it("«livrată» cu momentul livrării: acceptată", async () => {
    const error = await attempt((tx, orderId) =>
      tx.shipment.create({
        data: shipmentData(orderId, { status: "delivered", deliveredAt: new Date() }),
      }),
    );
    expect(error).toBeNull();
  });
  it("«anulată» fără momentul anulării: refuzată", async () => {
    await rejects(
      (tx, orderId) => tx.shipment.create({ data: shipmentData(orderId, { status: "cancelled" }) }),
      "shipment_cancelled_check",
    );
  });
  it("momentul anulării pe o expediere neanulată: refuzat", async () => {
    await rejects(
      (tx, orderId) =>
        tx.shipment.create({ data: shipmentData(orderId, { cancelledAt: new Date() }) }),
      "shipment_cancelled_check",
    );
  });
});

describe("expediere: unicitate", () => {
  it("a doua expediere outbound neanulată pe aceeași comandă: refuzată", async () => {
    await rejects(async (tx, orderId) => {
      await tx.shipment.create({ data: shipmentData(orderId) });
      await tx.shipment.create({ data: shipmentData(orderId) });
    }, "shipment_one_active_outbound");
  });
  it("după anularea primeia se poate crea alta", async () => {
    const error = await attempt(async (tx, orderId) => {
      const first = await tx.shipment.create({ data: shipmentData(orderId) });
      await tx.shipment.update({
        where: { id: first.id },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      await tx.shipment.create({ data: shipmentData(orderId) });
    });
    expect(error).toBeNull();
  });
  it("același AWB la același furnizor: refuzat (pe comenzi diferite)", async () => {
    const awb = `X-${uid()}`;
    const error = await inRolledBackTransaction(db, async (tx) => {
      const a = await order(tx);
      const b = await order(tx);
      await tx.shipment.create({
        data: shipmentData(a.id, { mode: "provider", provider: "demo", awb }),
      });
      try {
        await tx.shipment.create({
          data: shipmentData(b.id, { mode: "provider", provider: "demo", awb }),
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    });
    expect(error).not.toBeNull();
    expect(JSON.stringify(error) + String(error?.message)).toContain("shipment_provider_awb_key");
  });
  it("evenimentul de urmărire cu aceeași cheie nu se scrie de două ori (idempotență)", async () => {
    await rejects(async (tx, orderId) => {
      const s = await tx.shipment.create({ data: shipmentData(orderId) });
      const data = {
        shipmentId: s.id,
        eventKey: "k1",
        code: "10",
        label: "Livrat",
        occurredAt: new Date(),
      };
      await tx.shipmentEvent.create({ data });
      await tx.shipmentEvent.create({ data });
    }, "shipment_event_shipmentId_eventKey_key");
  });
});

describe("expediere: legături", () => {
  it("o comandă cu expediere nu se poate șterge (RESTRICT)", async () => {
    await rejects(async (tx, orderId) => {
      await tx.shipment.create({ data: shipmentData(orderId) });
      await tx.order.delete({ where: { id: orderId } });
    }, "shipment_orderId_fkey");
  });
});
