import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { queuePartialStorno } from "./partial-storno";
import { queueReverse } from "./invoice-schedule";

/**
 * Mini-faza `storno-total`, concurența pe Postgres REAL, cu date COMISE și conexiuni separate (pool): un storno parțial și unul
 * «total» cerute simultan pe aceeași factură NU depășesc niciodată totalul facturii (lacătul pe comandă și pe factura-părinte
 * serializează calculul restului cu crearea stornoului parțial). Fișier propriu (datele comise nu se amestecă cu testele în
 * tranzacție anulată); ce se creează aici se șterge la sfârșit.
 */
const pool = getDb();
const created: { orderIds: string[]; channelId: string | null } = { orderIds: [], channelId: null };

afterAll(async () => {
  // documentele de aici sunt simulate (DEMO), deci triggerul permite ștergerea lor
  await pool.invoice.deleteMany({ where: { orderId: { in: created.orderIds }, kind: "storno" } });
  await pool.invoice.deleteMany({ where: { orderId: { in: created.orderIds } } });
  await pool.order.deleteMany({ where: { id: { in: created.orderIds } } });
  if (created.channelId)
    await pool.salesChannel.delete({ where: { id: created.channelId } }).catch(() => undefined);
  await pool.$disconnect();
});

const TOTAL = 10_000; // 10 bucăți × 10,00 lei
const UNITS = 10;

/** O comandă cu o linie de 10 bucăți și factura ei EMISĂ (simulată), cu linia ei. */
async function invoicedOrder(): Promise<{ orderId: string; lineId: string }> {
  if (!created.channelId) {
    const channel = await pool.salesChannel.create({
      data: { code: `stc_${randomUUID().slice(0, 8)}`, name: "Canal test storno total" },
    });
    created.channelId = channel.id;
  }
  const order = await pool.order.create({
    data: {
      number: `STC-${randomUUID().slice(0, 10)}`,
      channelId: created.channelId,
      email: "client@exemplu.invalid",
      phone: "0722000000",
      subtotalMinor: TOTAL,
      shippingMinor: 0,
      taxMinor: 1_736,
      totalMinor: TOTAL,
      taxRateBps: 2100,
      shippingMethodCode: "pickup",
      shippingSnapshot: { kind: "pickup" },
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
      lines: {
        create: {
          sku: "STC-1",
          title: "Produs test",
          quantity: BigInt(UNITS) * 10_000n,
          unitSymbol: "buc",
          unitDecimals: 0,
          unitPriceMinor: 1_000,
          lineTotalMinor: TOTAL,
          netMinor: 8_264,
          taxMinor: 1_736,
          taxRateBps: 2100,
          stockState: "in_stock",
          shippingClass: "standard",
          productSnapshot: {},
        },
      },
    },
    include: { lines: true },
  });
  created.orderIds.push(order.id);
  const line = order.lines[0]!;
  await pool.invoice.create({
    data: {
      orderId: order.id,
      kind: "invoice",
      docKey: "invoice",
      totalMinor: TOTAL,
      taxMinor: 1_736,
      status: "issued",
      provider: "demo",
      simulated: true,
      series: "DEMO",
      number: `C${randomUUID().slice(0, 8)}`,
      providerRef: `demo-${randomUUID().slice(0, 6)}`,
      issuedAt: new Date(),
      lines: {
        create: {
          position: 1,
          kind: "product",
          orderLineId: line.id,
          sku: "STC-1",
          title: "Produs test",
          unitName: "buc",
          quantityTicks: BigInt(UNITS) * 10_000n,
          unitPriceMinor: 1_000,
          lineTotalMinor: TOTAL,
          netMinor: 8_264,
          taxMinor: 1_736,
          taxRateBps: 2100,
        },
      },
    },
  });
  return { orderId: order.id, lineId: line.id };
}

const reverse = (orderId: string) =>
  pool.$transaction((tx) => queueReverse(tx, orderId, { trigger: "manual", requestedBy: "test" }));

const partial = (orderId: string, lineId: string, reference: string, units: number) =>
  queuePartialStorno(
    pool,
    orderId,
    reference,
    [{ orderLineId: lineId, quantityTicks: BigInt(units) * 10_000n }],
    "test",
  );

async function stornoSum(orderId: string): Promise<{ total: number; hasTotalDoc: boolean }> {
  const rows = await pool.invoice.findMany({
    where: { orderId, kind: "storno", status: { not: "skipped" } },
  });
  return {
    total: rows.reduce((acc, r) => acc + r.totalMinor, 0),
    hasTotalDoc: rows.some((r) => r.docKey === "storno:total"),
  };
}

describe("storno parțial și storno «total» cerute simultan", () => {
  it("suma stornourilor nu depășește niciodată totalul facturii; dacă ambele reușesc, suma e EXACT totalul", async () => {
    let bothSucceeded = 0;
    let partialLost = 0;
    for (let round = 0; round < 24; round += 1) {
      const { orderId, lineId } = await invoicedOrder();
      const units = (round % 9) + 1; // 1..9 din 10 bucăți
      const [p, r] = await Promise.allSettled([
        partial(orderId, lineId, `ret-${round}`, units),
        reverse(orderId),
      ]);
      expect(r.status, `reverse la runda ${round}`).toBe("fulfilled");
      const { total, hasTotalDoc } = await stornoSum(orderId);
      expect(total, `runda ${round}`).toBeLessThanOrEqual(TOTAL);
      if (p.status === "fulfilled" && p.value !== null && hasTotalDoc) {
        bothSucceeded += 1;
        expect(total, `runda ${round}`).toBe(TOTAL);
      }
      if (p.status === "rejected") {
        // stornoul total a ajuns primul: partialul e refuzat cu eroare tipizată, nu cu o depășire
        partialLost += 1;
        expect(String((p.reason as { code?: string }).code)).toBe("INVOICE_STATE_INVALID");
        expect(total).toBe(TOTAL);
      }
    }
    // ambele ordini de serializare trebuie să fi apărut ori să nu fi pierdut nimic: invariantul de sus e cel care contează
    expect(bothSucceeded + partialLost).toBeGreaterThan(0);
  });

  it("mai multe cereri totale și parțiale deodată: un singur `storno:total`, suma ≤ totalul facturii", async () => {
    for (let round = 0; round < 8; round += 1) {
      const { orderId, lineId } = await invoicedOrder();
      await Promise.allSettled([
        partial(orderId, lineId, `a-${round}`, 3),
        reverse(orderId),
        partial(orderId, lineId, `b-${round}`, 2),
        reverse(orderId),
        partial(orderId, lineId, `c-${round}`, 4),
      ]);
      const rows = await pool.invoice.findMany({
        where: { orderId, kind: "storno", status: { not: "skipped" } },
      });
      expect(rows.filter((x) => x.docKey === "storno:total").length).toBeLessThanOrEqual(1);
      expect(
        rows.reduce((acc, x) => acc + x.totalMinor, 0),
        `runda ${round}`,
      ).toBeLessThanOrEqual(TOTAL);
    }
  });
});
