import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 14, schema contului și a retururilor. Fiecare constrângere are un test care o încalcă, iar CHECK-urile compuse au și cazul
 * «una setată, una nulă» (un CHECK cu rezultat NULL TRECE). Testele nu presupun date de seed: își creează singure clientul, canalul,
 * comanda și liniile, într-o tranzacție anulată.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const TICKS = 10_000n; // o unitate întreagă = 10.000 zecimi de miime

interface Fixture {
  userId: string;
  orderId: string;
  lineId: string;
  otherOrderLineId: string;
}

async function fixture(tx: TestTx, lineQty = 30_000n): Promise<Fixture> {
  const user = await tx.user.create({
    data: {
      id: `u_${uid()}`,
      name: "Client",
      email: `c-${uid()}@exemplu.test`,
      emailVerified: true,
    },
  });
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  const mk = async (qty: bigint) => {
    const o = await tx.order.create({
      data: {
        number: `T-${uid()}`,
        channelId: channel.id,
        email: user.email,
        phone: "0722000000",
        subtotalMinor: 10_000,
        shippingMinor: 0,
        taxMinor: 1_735,
        totalMinor: 10_000,
        taxRateBps: 2100,
        shippingMethodCode: "courier",
        shippingSnapshot: { kind: "courier" },
        paymentMethod: "cod",
        termsAcceptedAt: new Date(),
        termsConsentText: "Sunt de acord",
        termsConsentVersion: "t",
        idempotencyKey: randomUUID(),
      },
    });
    const l = await tx.orderLine.create({
      data: {
        orderId: o.id,
        sku: `S-${uid()}`,
        title: "Produs",
        quantity: qty,
        unitSymbol: "buc",
        unitDecimals: 0,
        unitPriceMinor: 3_333,
        lineTotalMinor: 10_000,
        netMinor: 8_265,
        taxMinor: 1_735,
        taxRateBps: 2100,
        stockState: "in_stock",
        shippingClass: "standard",
        productSnapshot: {},
      },
    });
    return { orderId: o.id, lineId: l.id };
  };
  const main = await mk(lineQty);
  const other = await mk(lineQty);
  return {
    userId: user.id,
    orderId: main.orderId,
    lineId: main.lineId,
    otherOrderLineId: other.lineId,
  };
}

async function newReturn(tx: TestTx, f: Fixture, over: Record<string, unknown> = {}) {
  return tx.returnRequest.create({
    data: { orderId: f.orderId, userId: f.userId, clientKey: randomUUID(), ...over },
  });
}

async function newItem(
  tx: TestTx,
  returnId: string,
  orderLineId: string,
  qty: bigint,
  over: Record<string, unknown> = {},
) {
  return tx.returnItem.create({
    data: { returnId, orderLineId, requestedQty: qty, reasonCode: "changed_mind", ...over },
  });
}

async function attempt(act: (tx: TestTx, f: Fixture) => Promise<unknown>, lineQty?: bigint) {
  return inRolledBackTransaction(db, async (tx) => {
    const f = await fixture(tx, lineQty);
    try {
      await act(tx, f);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

async function rejects(
  act: (tx: TestTx, f: Fixture) => Promise<unknown>,
  expected: string,
  lineQty?: bigint,
) {
  const error = await attempt(act, lineQty);
  expect(error, `baza trebuia să respingă scrierea (${expected})`).not.toBeNull();
  expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

async function accepts(act: (tx: TestTx, f: Fixture) => Promise<unknown>, lineQty?: bigint) {
  const error = await attempt(act, lineQty);
  expect(error?.message ?? null).toBeNull();
}

const PAID = (orderId: string) => ({
  orderId,
  provider: "cod",
  method: "cod",
  amountMinor: 10_000,
  status: "paid",
  capturedAt: new Date(),
  capturedAmountMinor: 10_000,
  capturedCurrency: "RON",
});

const cancel = (tx: TestTx, id: string) =>
  tx.returnRequest.update({
    where: { id },
    data: { status: "cancelled", cancelledAt: new Date() },
  });

describe("retur: valori și câmpuri legate", () => {
  it("respinge un status necunoscut și un mod de trimitere necunoscut", async () => {
    await rejects((tx, f) => newReturn(tx, f, { status: "gata" }), "return_request_status_ck");
    await rejects(
      (tx, f) => newReturn(tx, f, { sendMode: "drona" }),
      "return_request_send_mode_ck",
    );
    await accepts((tx, f) => newReturn(tx, f));
  });

  it("AWB-ul de retur: numărul, curierul și momentul vin împreună (una setată, una nulă)", async () => {
    const now = new Date();
    await accepts((tx, f) =>
      newReturn(tx, f, { returnAwb: "A1", returnCarrier: "Curier", returnAwbAt: now }),
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { returnAwb: "A1", returnAwbAt: now }),
      "return_request_awb_ck",
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { returnCarrier: "Curier", returnAwbAt: now }),
      "return_request_awb_ck",
    );
    await rejects((tx, f) => newReturn(tx, f, { returnAwbAt: now }), "return_request_awb_ck");
    await rejects(
      (tx, f) => newReturn(tx, f, { returnAwb: "A1", returnCarrier: "Curier" }),
      "return_request_awb_ck",
    );
  });

  it("un retur respins are motiv și moment; unul anulat are momentul anulării", async () => {
    const now = new Date();
    await rejects(
      (tx, f) => newReturn(tx, f, { status: "rejected", rejectedAt: now }),
      "return_request_rejected_ck",
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { status: "rejected", rejectReason: "Motiv" }),
      "return_request_rejected_ck",
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { status: "cancelled" }),
      "return_request_cancelled_ck",
    );
  });

  it("un retur rambursat are rambursarea și momentul; rambursarea cere suma produselor", async () => {
    await rejects(
      (tx, f) => newReturn(tx, f, { status: "refunded", refundedAt: new Date() }),
      "return_request_refunded_ck",
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { refundProductsMinor: -1 }),
      "return_request_refund_amount_ck",
    );
  });

  it("transportul rambursat manual cere un motiv", async () => {
    await rejects(
      (tx, f) => newReturn(tx, f, { refundShippingMinor: 1_000 }),
      "return_request_refund_shipping_reason_ck",
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { refundShippingMinor: 1_000, refundShippingReason: "  " }),
      "return_request_refund_shipping_reason_ck",
    );
    await rejects(
      (tx, f) => newReturn(tx, f, { refundShippingMinor: -5, refundShippingReason: "x" }),
      "return_request_refund_amount_ck",
    );
    await accepts((tx, f) =>
      newReturn(tx, f, { refundShippingMinor: 1_000, refundShippingReason: "Produs defect" }),
    );
  });

  it("starea stornoului acceptă doar valorile cunoscute", async () => {
    await rejects(
      (tx, f) => newReturn(tx, f, { stornoState: "x" }),
      "return_request_storno_state_ck",
    );
    await accepts((tx, f) => newReturn(tx, f, { stornoState: "queued" }));
  });

  it("aceeași cheie de idempotență a aceluiași client nu creează al doilea retur", async () => {
    await rejects(async (tx, f) => {
      await newReturn(tx, f, { clientKey: "k1" });
      await newReturn(tx, f, { clientKey: "k1" });
    }, "Unique constraint");
  });
});

describe("linie de retur: cantități, inspecție, motiv", () => {
  it("cantitatea cerută e pozitivă", async () => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, 0n);
    }, "return_item_requested_qty_ck");
  });

  it("inspecția: cantitatea acceptată, starea și «revandabil» vin împreună (una setată, una nulă)", async () => {
    const full = { acceptedQty: TICKS, condition: "as_new", resellable: true };
    await accepts(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, full);
    });
    for (const partial of [
      { acceptedQty: TICKS },
      { condition: "as_new" },
      { resellable: true },
      { acceptedQty: TICKS, condition: "as_new" },
      { acceptedQty: TICKS, resellable: false },
      { condition: "opened", resellable: false },
    ]) {
      await rejects(async (tx, f) => {
        const r = await newReturn(tx, f);
        await newItem(tx, r.id, f.lineId, TICKS, partial);
      }, "return_item_inspection_ck");
    }
  });

  it("cantitatea acceptată nu depășește cea cerută și nu e negativă; starea constatată e din listă", async () => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, {
        acceptedQty: TICKS + 1n,
        condition: "as_new",
        resellable: true,
      });
    }, "return_item_accepted_range_ck");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, {
        acceptedQty: -1n,
        condition: "as_new",
        resellable: true,
      });
    }, "return_item_accepted_range_ck");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, {
        acceptedQty: 0n,
        condition: "stricat",
        resellable: false,
      });
    }, "return_item_condition_ck");
  });

  it("repunerea pe stoc cere o linie acceptată și revandabilă (una setată, una nulă)", async () => {
    const now = new Date();
    await accepts(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, {
        acceptedQty: TICKS,
        condition: "as_new",
        resellable: true,
        restockedAt: now,
      });
    });
    for (const bad of [
      { restockedAt: now },
      { acceptedQty: TICKS, condition: "damaged", resellable: false, restockedAt: now },
      { acceptedQty: 0n, condition: "as_new", resellable: true, restockedAt: now },
    ]) {
      await rejects(async (tx, f) => {
        const r = await newReturn(tx, f);
        await newItem(tx, r.id, f.lineId, TICKS, bad);
      }, "return_item_restocked_ck");
    }
  });

  it("suma rambursată pe linie cere o linie inspectată și nu e negativă", async () => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, { refundLineMinor: 100 });
    }, "return_item_refund_line_ck");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, {
        acceptedQty: TICKS,
        condition: "as_new",
        resellable: true,
        refundLineMinor: -1,
      });
    }, "return_item_refund_line_ck");
  });

  it("motivul e din listă, iar «altul» cere text", async () => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, { reasonCode: "capriciu" });
    }, "return_item_reason_ck");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, { reasonCode: "other" });
    }, "return_item_reason_text_ck");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, { reasonCode: "other", reasonText: " " });
    }, "return_item_reason_text_ck");
    await accepts(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS, { reasonCode: "other", reasonText: "Alt motiv" });
    });
  });

  it("aceeași linie nu apare de două ori în același retur", async () => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      await newItem(tx, r.id, f.lineId, TICKS);
      await newItem(tx, r.id, f.lineId, TICKS);
    }, "Unique constraint");
  });

  it("ce a cerut clientul nu se mai schimbă", async () => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      const i = await newItem(tx, r.id, f.lineId, TICKS);
      await tx.returnItem.update({ where: { id: i.id }, data: { requestedQty: 2n * TICKS } });
    }, "return_item_frozen");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      const i = await newItem(tx, r.id, f.lineId, TICKS);
      await tx.returnItem.update({
        where: { id: i.id },
        data: { orderLineId: f.otherOrderLineId },
      });
    }, "return_item_frozen");
  });

  it("o linie repusă pe stoc nu mai poate fi nici dezmarcată, nici reinspectată", async () => {
    const setup = async (tx: TestTx, f: Fixture) => {
      const r = await newReturn(tx, f);
      return newItem(tx, r.id, f.lineId, TICKS, {
        acceptedQty: TICKS,
        condition: "as_new",
        resellable: true,
        restockedAt: new Date(),
      });
    };
    await rejects(async (tx, f) => {
      const i = await setup(tx, f);
      await tx.returnItem.update({ where: { id: i.id }, data: { restockedAt: null } });
    }, "return_item_restocked");
    await rejects(async (tx, f) => {
      const i = await setup(tx, f);
      await tx.returnItem.update({
        where: { id: i.id },
        data: { restockedAt: new Date(Date.now() + 1000) },
      });
    }, "return_item_restocked");
    await rejects(async (tx, f) => {
      const i = await setup(tx, f);
      await tx.returnItem.update({
        where: { id: i.id },
        data: { acceptedQty: 0n, resellable: false },
      });
    }, "return_item_restocked");
  });
});

describe("retur: cantitatea nu depășește cea comandată", () => {
  it("al doilea retur nu poate cere mai mult decât a rămas", async () => {
    await rejects(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.lineId, 20_000n);
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 20_000n);
    }, "return_quantity_exceeded");
  });

  it("restul se poate returna, până la ultima bucată; apoi nimic", async () => {
    await rejects(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.lineId, 20_000n);
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 10_000n);
      const c = await newReturn(tx, f);
      await newItem(tx, c.id, f.lineId, 1n);
    }, "return_quantity_exceeded");
  });

  it("un singur retur nu poate cere mai mult decât s-a comandat", async () => {
    await rejects(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.lineId, 30_001n);
    }, "return_quantity_exceeded");
  });

  it("anularea eliberează cantitatea", async () => {
    await accepts(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.lineId, 30_000n);
      await cancel(tx, a.id);
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 30_000n);
    });
  });

  it("respingerea eliberează cantitatea", async () => {
    await accepts(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.lineId, 30_000n);
      await tx.returnRequest.update({
        where: { id: a.id },
        data: { status: "rejected", rejectedAt: new Date(), rejectReason: "Nu" },
      });
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 30_000n);
    });
  });

  it("după inspecție contează doar cantitatea acceptată: restul nerecunoscut se poate cere din nou", async () => {
    await accepts(async (tx, f) => {
      const a = await newReturn(tx, f);
      const i = await newItem(tx, a.id, f.lineId, 30_000n);
      for (const status of ["approved", "awaiting_shipment", "received"]) {
        await tx.returnRequest.update({ where: { id: a.id }, data: { status } });
      }
      await tx.returnItem.update({
        where: { id: i.id },
        data: { acceptedQty: 10_000n, condition: "opened", resellable: false },
      });
      await tx.returnRequest.update({ where: { id: a.id }, data: { status: "inspected" } });
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 20_000n);
    });
    await rejects(async (tx, f) => {
      const a = await newReturn(tx, f);
      const i = await newItem(tx, a.id, f.lineId, 30_000n);
      for (const status of ["approved", "awaiting_shipment", "received"]) {
        await tx.returnRequest.update({ where: { id: a.id }, data: { status } });
      }
      await tx.returnItem.update({
        where: { id: i.id },
        data: { acceptedQty: 10_000n, condition: "opened", resellable: false },
      });
      await tx.returnRequest.update({ where: { id: a.id }, data: { status: "inspected" } });
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 20_001n);
    }, "return_quantity_exceeded");
  });

  it("linia aparține comenzii returului", async () => {
    await rejects(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.otherOrderLineId, TICKS);
    }, "return_item_wrong_order");
  });

  it("liniile se adaugă doar la crearea returului", async () => {
    await rejects(async (tx, f) => {
      const a = await newReturn(tx, f);
      await tx.returnRequest.update({ where: { id: a.id }, data: { status: "approved" } });
      await newItem(tx, a.id, f.lineId, TICKS);
    }, "return_item_not_open");
  });

  it("cantitățile fracționare (4 zecimale) se însumează exact", async () => {
    // 6,0900 mp comandați: 2,5000 + 3,5900 încap, 0,0001 în plus nu
    await accepts(async (tx, f) => {
      const a = await newReturn(tx, f);
      await newItem(tx, a.id, f.lineId, 25_000n);
      const b = await newReturn(tx, f);
      await newItem(tx, b.id, f.lineId, 35_900n);
    }, 60_900n);
    await rejects(
      async (tx, f) => {
        const a = await newReturn(tx, f);
        await newItem(tx, a.id, f.lineId, 25_000n);
        const b = await newReturn(tx, f);
        await newItem(tx, b.id, f.lineId, 35_901n);
      },
      "return_quantity_exceeded",
      60_900n,
    );
  });
});

describe("retur: tranziții de stare în bază", () => {
  const ALLOWED: Record<string, string[]> = {
    requested: ["approved", "rejected", "cancelled"],
    approved: ["awaiting_shipment", "cancelled"],
    awaiting_shipment: ["received", "cancelled"],
    received: ["inspected"],
    inspected: ["refunded", "rejected"],
    refunded: [],
    rejected: [],
    cancelled: [],
  };
  const ALL = Object.keys(ALLOWED);
  // cum ajunge un retur într-o stare, ca să se încerce tranziția din ea
  const PATH: Record<string, string[]> = {
    requested: [],
    approved: ["approved"],
    awaiting_shipment: ["approved", "awaiting_shipment"],
    received: ["approved", "awaiting_shipment", "received"],
    inspected: ["approved", "awaiting_shipment", "received", "inspected"],
    refunded: [],
    rejected: [],
    cancelled: [],
  };

  const extra = (to: string, refundId: string | null) => {
    const now = new Date();
    if (to === "rejected") return { rejectReason: "Motiv", rejectedAt: now };
    if (to === "cancelled") return { cancelledAt: now };
    if (to === "refunded") return { refundedAt: now, refundId, refundProductsMinor: 100 };
    return {};
  };

  it.each(
    ALL.filter((from) =>
      ["requested", "approved", "awaiting_shipment", "received", "inspected"].includes(from),
    ),
  )("din %s: doar tranzițiile permise", async (from) => {
    for (const to of ALL) {
      if (to === from) continue;
      const act = async (tx: TestTx, f: Fixture) => {
        const r = await newReturn(tx, f);
        for (const step of PATH[from] ?? []) {
          await tx.returnRequest.update({ where: { id: r.id }, data: { status: step } });
        }
        let refundId: string | null = null;
        if (to === "refunded") {
          const p = await tx.payment.create({
            data: PAID(f.orderId),
          });
          const refund = await tx.refund.create({
            data: {
              paymentId: p.id,
              orderId: f.orderId,
              amountMinor: 100,
              reason: "t",
              kind: "admin",
              idempotencyKey: randomUUID(),
            },
          });
          refundId = refund.id;
        }
        await tx.returnRequest.update({
          where: { id: r.id },
          data: { status: to, ...extra(to, refundId) },
        });
      };
      if (ALLOWED[from]?.includes(to)) await accepts(act);
      else await rejects(act, "return_status_transition");
    }
  });

  it.each(["refunded", "rejected", "cancelled"])("%s e stare finală", async (from) => {
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      if (from === "cancelled") await cancel(tx, r.id);
      else if (from === "rejected") {
        await tx.returnRequest.update({
          where: { id: r.id },
          data: { status: "rejected", rejectedAt: new Date(), rejectReason: "x" },
        });
      } else {
        for (const step of ["approved", "awaiting_shipment", "received", "inspected"]) {
          await tx.returnRequest.update({ where: { id: r.id }, data: { status: step } });
        }
        const p = await tx.payment.create({
          data: PAID(f.orderId),
        });
        const refund = await tx.refund.create({
          data: {
            paymentId: p.id,
            orderId: f.orderId,
            amountMinor: 100,
            reason: "t",
            kind: "admin",
            idempotencyKey: randomUUID(),
          },
        });
        await tx.returnRequest.update({
          where: { id: r.id },
          data: {
            status: "refunded",
            refundedAt: new Date(),
            refundId: refund.id,
            refundProductsMinor: 100,
          },
        });
      }
      await tx.returnRequest.update({ where: { id: r.id }, data: { status: "requested" } });
    }, "return_status_transition");
  });
});

describe("jurnalul returului", () => {
  it("se adaugă, nu se modifică și nu se șterge", async () => {
    await accepts(async (tx, f) => {
      const r = await newReturn(tx, f);
      await tx.returnEvent.create({
        data: { returnId: r.id, type: "return.requested", message: "Cerere" },
      });
    });
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      const e = await tx.returnEvent.create({ data: { returnId: r.id, type: "t", message: "m" } });
      await tx.returnEvent.update({ where: { id: e.id }, data: { message: "altceva" } });
    }, "return_event_append_only");
    await rejects(async (tx, f) => {
      const r = await newReturn(tx, f);
      const e = await tx.returnEvent.create({ data: { returnId: r.id, type: "t", message: "m" } });
      await tx.returnEvent.delete({ where: { id: e.id } });
    }, "return_event_append_only");
  });

  it("ștergerea returului ia cu ea jurnalul (curățarea datelor de test)", async () => {
    await accepts(async (tx, f) => {
      const r = await newReturn(tx, f);
      await tx.returnEvent.create({ data: { returnId: r.id, type: "t", message: "m" } });
      await tx.returnRequest.delete({ where: { id: r.id } });
    });
  });
});

describe("agenda de adrese, wishlist, preferințe", () => {
  async function siruta(tx: TestTx) {
    const code = 900_000_000 + Math.floor(Math.random() * 90_000_000);
    const county = await tx.sirutaUnit.create({
      data: { code, countyCode: code, name: "Județ", tip: 40, level: 1, sourceVersion: "t" },
    });
    const locality = await tx.sirutaUnit.create({
      data: {
        code: code + 1,
        countyCode: code,
        name: "Localitate",
        parentCode: code,
        tip: 3,
        level: 3,
        sourceVersion: "t",
      },
    });
    return { county: county.code, locality: locality.code };
  }
  const address = (
    userId: string,
    s: { county: number; locality: number },
    over: Record<string, unknown> = {},
  ) => ({
    userId,
    fullName: "Ion Popescu",
    phone: "0722000000",
    countySirutaCode: s.county,
    countyName: "Județ",
    localitySirutaCode: s.locality,
    localityName: "Localitate",
    street: "Str. Test 1",
    postalCode: "100100",
    ...over,
  });

  it("o singură adresă implicită de livrare și una de facturare pe client", async () => {
    await accepts(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({ data: address(f.userId, s, { isDefaultShipping: true }) });
      await tx.customerAddress.create({ data: address(f.userId, s, { isDefaultBilling: true }) });
      await tx.customerAddress.create({ data: address(f.userId, s) });
    });
    await rejects(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({ data: address(f.userId, s, { isDefaultShipping: true }) });
      await tx.customerAddress.create({ data: address(f.userId, s, { isDefaultShipping: true }) });
    }, "customer_address_default_shipping_uq");
    await rejects(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({ data: address(f.userId, s, { isDefaultBilling: true }) });
      await tx.customerAddress.create({ data: address(f.userId, s, { isDefaultBilling: true }) });
    }, "customer_address_default_billing_uq");
  });

  it("codul poștal are 6 cifre", async () => {
    await rejects(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({ data: address(f.userId, s, { postalCode: "1001" }) });
    }, "customer_address_postal_code_ck");
  });

  it("CUI-ul și starea verificării vin împreună (una setată, una nulă)", async () => {
    await accepts(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({
        data: address(f.userId, s, { vatId: "RO123", vatIdVerification: "verified" }),
      });
    });
    await rejects(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({ data: address(f.userId, s, { vatId: "RO123" }) });
    }, "customer_address_vat_ck");
    await rejects(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({
        data: address(f.userId, s, { vatIdVerification: "verified" }),
      });
    }, "customer_address_vat_ck");
    await rejects(async (tx, f) => {
      const s = await siruta(tx);
      await tx.customerAddress.create({
        data: address(f.userId, s, { vatId: "RO123", vatIdVerification: "poate" }),
      });
    }, "customer_address_vat_ck");
  });

  it("adresa trebuie să arate spre un județ și o localitate din SIRUTA", async () => {
    await rejects(
      (tx, f) =>
        tx.customerAddress.create({
          data: address(f.userId, { county: 1, locality: 2 }),
        }),
      "Foreign key",
    );
  });

  it("o variantă apare o singură dată în wishlist-ul unui client", async () => {
    const mk = async (tx: TestTx, f: Fixture) => {
      const p = await tx.product.create({
        data: { slug: `p-${uid()}`, title: "P", status: "active" },
      });
      const v = await tx.productVariant.create({
        data: { productId: p.id, sku: `V-${uid()}`, price: 1000 },
      });
      await tx.wishlistItem.create({ data: { userId: f.userId, variantId: v.id } });
      return v;
    };
    await accepts((tx, f) => mk(tx, f));
    await rejects(async (tx, f) => {
      const v = await mk(tx, f);
      await tx.wishlistItem.create({ data: { userId: f.userId, variantId: v.id } });
    }, "Unique constraint");
  });

  it("telefonul din profil are forma +40 și 9 cifre", async () => {
    await accepts((tx, f) =>
      tx.customerPreference.create({ data: { userId: f.userId, phone: "+40722123456" } }),
    );
    for (const bad of ["0722123456", "+4072212345", "+407221234567", "telefon"]) {
      await rejects(
        (tx, f) => tx.customerPreference.create({ data: { userId: f.userId, phone: bad } }),
        "customer_preference_phone_ck",
      );
    }
  });

  it("preferințele: «oferte și noutăți» e oprit implicit; o decizie păstrează momentul ȘI textul (una setată, una nulă)", async () => {
    await accepts(async (tx, f) => {
      const p = await tx.customerPreference.create({ data: { userId: f.userId } });
      expect(p.marketingOptIn).toBe(false);
    });
    await accepts((tx, f) =>
      tx.customerPreference.create({
        data: {
          userId: f.userId,
          marketingOptIn: true,
          marketingDecisionAt: new Date(),
          marketingDecisionText: "Vreau oferte",
        },
      }),
    );
    await rejects(
      (tx, f) =>
        tx.customerPreference.create({
          data: { userId: f.userId, marketingDecisionAt: new Date() },
        }),
      "customer_preference_decision_ck",
    );
    await rejects(
      (tx, f) =>
        tx.customerPreference.create({ data: { userId: f.userId, marketingDecisionText: "Text" } }),
      "customer_preference_decision_ck",
    );
    await rejects(
      (tx, f) => tx.customerPreference.create({ data: { userId: f.userId, marketingOptIn: true } }),
      "customer_preference_decision_ck",
    );
  });
});
