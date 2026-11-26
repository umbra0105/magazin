import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { vatFromGross } from "@ecom/shared";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Verificarea totalurilor comenzii (`order_totals_integrity`, AMÂNATĂ la COMMIT) cu puncte de loialitate (decizia 2026-11-26):
 * «TVA comandă = TVA produse − TVA reduceri + transport + ramburs»; fără puncte regula e identică celei vechi. O tranzacție
 * anulată NU rulează verificările amânate, de aceea testele de aici fie le FORȚEAZĂ (`SET CONSTRAINTS ALL IMMEDIATE`), fie
 * SALVEAZĂ DEFINITIV comanda și o șterg explicit la final.
 */
const db = getDb();
const committed: { orders: string[]; channels: string[] } = { orders: [], channels: [] };

afterAll(async () => {
  await db.order.deleteMany({ where: { id: { in: committed.orders } } });
  await db.salesChannel.deleteMany({ where: { id: { in: committed.channels } } });
  await db.$disconnect();
});

const uid = (): string => randomUUID().replaceAll("-", "").slice(0, 12);
const RATE = 2100;
const vat = (gross: number): number => vatFromGross(gross, RATE);

interface Shape {
  /** [brut, partea de reducere din puncte] pe fiecare linie. */
  lines: Array<[number, number]>;
  shipping?: number;
  /** Abateri intenționate, în bani. */
  orderTaxOff?: number;
  lineDiscountTax?: (share: number) => number;
}

/** Comanda cu liniile ei, în tranzacția dată; întoarce id-ul comenzii și al primei linii. */
async function write(tx: TestTx, shape: Shape) {
  const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
  const shipping = shape.shipping ?? 2_000;
  const subtotal = shape.lines.reduce((sum, [gross]) => sum + gross, 0);
  const discount = shape.lines.reduce((sum, [, share]) => sum + share, 0);
  const discountTax = shape.lineDiscountTax ?? vat;
  const tax =
    shape.lines.reduce((sum, [gross, share]) => sum + vat(gross) - discountTax(share), 0) +
    vat(shipping) +
    (shape.orderTaxOff ?? 0);
  const order = await tx.order.create({
    select: { id: true },
    data: {
      number: `T-${uid()}`,
      channelId: channel.id,
      email: "totaluri@exemplu.test",
      phone: "0722000000",
      subtotalMinor: subtotal,
      discountMinor: discount,
      shippingMinor: shipping,
      shippingTaxMinor: vat(shipping),
      taxMinor: tax,
      totalMinor: subtotal - discount + shipping,
      taxRateBps: RATE,
      shippingMethodCode: "courier",
      shippingSnapshot: {},
      paymentMethod: "cod",
      termsAcceptedAt: new Date(),
      termsConsentText: "Sunt de acord",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
      ...(discount > 0
        ? {
            loyaltyCustomerId: "u_totaluri",
            loyaltyPointsUsed: Math.floor(discount / 100),
            loyaltyPointValueMinor: 100,
            loyaltyVatMode: "base_reduced",
          }
        : {}),
    },
  });
  let firstLine = "";
  for (const [index, [gross, share]] of shape.lines.entries()) {
    const line = await tx.orderLine.create({
      select: { id: true },
      data: {
        orderId: order.id,
        sku: `K-${uid()}-${index}`,
        title: "Produs",
        quantity: 10_000n,
        unitSymbol: "buc",
        unitDecimals: 0,
        unitPriceMinor: gross,
        lineTotalMinor: gross,
        netMinor: gross - vat(gross),
        taxMinor: vat(gross),
        taxRateBps: RATE,
        stockState: "in_stock",
        shippingClass: "standard",
        productSnapshot: {},
        loyaltyDiscountMinor: share,
        loyaltyDiscountTaxMinor: discountTax(share),
      },
    });
    firstLine ||= line.id;
  }
  return { orderId: order.id, channelId: channel.id, lineId: firstLine };
}

const force = (tx: TestTx) => tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");

/** Scrie comanda într-o tranzacție anulată și forțează verificarea de la COMMIT. */
const checked = (shape: Shape) =>
  inRolledBackTransaction(db, async (tx) => {
    await write(tx, shape);
    await force(tx);
  });

/** Salvează DEFINITIV comanda (verificarea rulează la COMMIT); curățarea e în `afterAll`. */
async function save(shape: Shape): Promise<string> {
  const saved = await db.$transaction((tx) => write(tx, shape));
  committed.orders.push(saved.orderId);
  committed.channels.push(saved.channelId);
  return saved.orderId;
}

const WRONG = /TVA-ul \(\d+\) nu e suma TVA-urilor/;

describe("fără puncte, regula e identică cu cea veche", () => {
  it("TVA corect: salvat definitiv", async () => {
    const id = await save({
      lines: [
        [10_000, 0],
        [333, 0],
      ],
    });
    expect(await db.order.count({ where: { id } })).toBe(1);
  });

  it.each([1, -1])("TVA greșit cu %i ban: refuzat la COMMIT", async (off) => {
    await expect(save({ lines: [[10_000, 0]], orderTaxOff: off })).rejects.toThrow(WRONG);
    await expect(checked({ lines: [[10_000, 0]], orderTaxOff: off })).rejects.toThrow(WRONG);
  });
});

describe("cu puncte: TVA comandă = TVA produse − TVA reduceri + transport + ramburs", () => {
  it("exemplul aprobat (100,00 lei, reducere 33,33 lei → 11,58 lei TVA pe produse): salvat definitiv", async () => {
    const id = await save({ lines: [[10_000, 3_333]] });
    const row = await db.order.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect(row.taxMinor - row.shippingTaxMinor).toBe(1_158);
    expect(row.lines[0]).toMatchObject({ taxMinor: 1_736, loyaltyDiscountTaxMinor: 578 });
  });

  it("linie plătită integral cu puncte, lângă una fără puncte: salvată definitiv", async () => {
    await save({
      lines: [
        [10_000, 10_000],
        [5_000, 0],
      ],
    });
  });

  it.each([1, -1])("TVA-ul comenzii greșit cu %i ban: refuzat", async (off) => {
    await expect(save({ lines: [[10_000, 3_333]], orderTaxOff: off })).rejects.toThrow(WRONG);
  });

  it("TVA-ul comenzii calculat FĂRĂ reducere (regula veche) e refuzat", async () => {
    // comanda păstrează TVA-ul întreg, dar linia spune că reducerea are TVA 578
    await expect(checked({ lines: [[10_000, 3_333]], orderTaxOff: 578 })).rejects.toThrow(WRONG);
  });

  it("verificarea rulează și la inserarea unei linii în plus", async () => {
    const id = await save({ lines: [[10_000, 3_333]] });
    await expect(
      db.$transaction(async (tx) => {
        await tx.orderLine.create({
          data: {
            orderId: id,
            sku: `K-${uid()}`,
            title: "În plus",
            quantity: 10_000n,
            unitSymbol: "buc",
            unitDecimals: 0,
            unitPriceMinor: 0,
            lineTotalMinor: 0,
            netMinor: 0,
            taxMinor: 0,
            taxRateBps: RATE,
            stockState: "in_stock",
            shippingClass: "standard",
            productSnapshot: {},
          },
        });
        await tx.$executeRaw`UPDATE order_line SET "variantId" = NULL WHERE "orderId" = ${id}`;
        await tx.orderLine.deleteMany({ where: { orderId: id, loyaltyDiscountMinor: { gt: 0 } } });
      }),
    ).rejects.toThrow(/subtotalul|TVA-ul/);
  });
});

describe("coloana TVA-ului reducerii", () => {
  it("e 0 implicit", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { lineId } = await write(tx, { lines: [[10_000, 0]] });
      expect(
        (await tx.orderLine.findUniqueOrThrow({ where: { id: lineId } })).loyaltyDiscountTaxMinor,
      ).toBe(0);
    });
  });

  it.each([
    ["negativ", (share: number) => (share > 0 ? -1 : 0)],
    ["peste valoarea reducerii", (share: number) => (share > 0 ? share + 1 : 0)],
    [
      "setat pe o linie fără reducere (una setată, una zero)",
      (share: number) => (share === 0 ? 1 : vat(share)),
    ],
  ])("%s: refuzat de CHECK", async (label, lineDiscountTax) => {
    const lines: Array<[number, number]> = label.startsWith("setat")
      ? [[10_000, 0]]
      : [[10_000, 100]];
    await expect(checked({ lines, lineDiscountTax })).rejects.toThrow(
      /order_line_loyalty_tax_check/,
    );
  });

  it("nu poate fi nul (una setată, una nulă)", async () => {
    await expect(
      inRolledBackTransaction(db, async (tx) => {
        const { lineId } = await write(tx, { lines: [[10_000, 3_333]] });
        await tx.$executeRaw`UPDATE order_line SET "loyaltyDiscountTaxMinor" = NULL WHERE id = ${lineId}`;
      }),
    ).rejects.toThrow();
  });

  it("e imuabilă", async () => {
    await expect(
      inRolledBackTransaction(db, async (tx) => {
        const { lineId } = await write(tx, { lines: [[10_000, 3_333]] });
        await tx.orderLine.update({ where: { id: lineId }, data: { loyaltyDiscountTaxMinor: 0 } });
      }),
    ).rejects.toThrow(/instantaneul punctelor/);
  });
});
