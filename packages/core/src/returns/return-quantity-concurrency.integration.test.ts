import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";

/**
 * Faza 14: două cereri SIMULTANE pentru ultima bucată dintr-o linie de comandă, pe Postgres real, cu tranzacții comise (nu anulate):
 * una reușește, a doua primește `return_quantity_exceeded`. Garanția stă în bază (trigger cu blocarea liniei), nu în aplicație.
 * Datele create aici se șterg la sfârșit.
 */
const db = getDb();
const tag = randomUUID().slice(0, 8);
let userId = "";
let channelId = "";
let orderId = "";
let lineId = "";

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      id: `u_${tag}`,
      name: "Client",
      email: `conc-${tag}@exemplu.test`,
      emailVerified: true,
    },
  });
  userId = user.id;
  const channel = await db.salesChannel.create({ data: { code: `conc_${tag}`, name: "Canal" } });
  channelId = channel.id;
  await db.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        number: `CONC-${tag}`,
        channelId,
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
    orderId = order.id;
    const line = await tx.orderLine.create({
      data: {
        orderId,
        sku: `CONC-${tag}`,
        title: "Produs",
        quantity: 30_000n, // 3 bucăți
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
    lineId = line.id;
  });
});

afterAll(async () => {
  if (orderId !== "") {
    await db.returnRequest.deleteMany({ where: { orderId } });
    await db.order.delete({ where: { id: orderId } });
  }
  await db.salesChannel.delete({ where: { id: channelId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

async function requestReturn(qty: bigint): Promise<"ok" | "exceeded" | string> {
  try {
    await db.$transaction(async (tx) => {
      const r = await tx.returnRequest.create({
        data: { orderId, userId, clientKey: randomUUID() },
      });
      await tx.returnItem.create({
        data: {
          returnId: r.id,
          orderLineId: lineId,
          requestedQty: qty,
          reasonCode: "changed_mind",
        },
      });
    });
    return "ok";
  } catch (e) {
    const text = JSON.stringify(e) + String(e instanceof Error ? e.message : e);
    return text.includes("return_quantity_exceeded") ? "exceeded" : text.slice(0, 300);
  }
}

describe("retur: concurență pe ultima bucată", () => {
  it("din 8 cereri simultane câte pentru 1 bucată, încap exact 3", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => requestReturn(10_000n)));
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "exceeded")).toHaveLength(5);
    const stored = await db.returnItem.aggregate({
      where: { orderLineId: lineId },
      _sum: { requestedQty: true },
    });
    expect(stored._sum.requestedQty).toBe(30_000n);
  });

  it("două cereri simultane pentru ultima bucată: una reușește, una e refuzată", async () => {
    // linia are 3 bucăți, toate cerute mai sus: anulăm un retur ca să rămână exact una
    const one = await db.returnRequest.findFirstOrThrow({ where: { orderId } });
    await db.returnRequest.update({
      where: { id: one.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    const results = await Promise.all([requestReturn(10_000n), requestReturn(10_000n)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "exceeded")).toHaveLength(1);
  });
});
