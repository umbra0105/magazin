import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";

/**
 * Faza 9, schema comenzilor. Fiecare constrângere are cel puțin un test care o încalcă, iar CHECK-urile compuse au și cazul
 * «una setată, una nulă» (un CHECK cu rezultat NULL TRECE, deci fiecare coloană e comparată explicit). Testele nu presupun
 * date de seed: își creează singure canalul, produsul și unitățile SIRUTA, într-o tranzacție anulată.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
let sirutaSeq = 900_000;

async function siruta(tx: TestTx) {
  const county = await tx.sirutaUnit.create({
    data: {
      code: sirutaSeq++,
      countyCode: 99,
      name: "JUDEȚUL TEST",
      parentCode: null,
      tip: 40,
      level: 1,
      sourceVersion: "test",
    },
  });
  const uat = await tx.sirutaUnit.create({
    data: {
      code: sirutaSeq++,
      countyCode: 99,
      name: "COMUNA TEST",
      parentCode: county.code,
      tip: 3,
      level: 2,
      sourceVersion: "test",
    },
  });
  const locality = await tx.sirutaUnit.create({
    data: {
      code: sirutaSeq++,
      countyCode: 99,
      name: "SAT TEST",
      parentCode: uat.code,
      tip: 22,
      level: 3,
      sourceVersion: "test",
    },
  });
  return { county, uat, locality };
}

async function base(tx: TestTx) {
  const channel = await tx.salesChannel.create({
    data: { code: `t_${uid()}`, name: "Canal test" },
  });
  const product = await tx.product.create({ data: { slug: `p-${uid()}`, title: "Produs" } });
  const variant = await tx.productVariant.create({
    data: { productId: product.id, sku: `SKU-${uid()}`, price: 10_000 },
  });
  const geo = await siruta(tx);
  return { channel, product, variant, geo };
}

const orderData = (channelId: string, over: Record<string, unknown> = {}) => ({
  number: `T-${uid()}`,
  channelId,
  email: "client@exemplu.ro",
  phone: "0722000000",
  subtotalMinor: 10_000,
  shippingMinor: 1_500,
  codFeeMinor: 500,
  shippingTaxMinor: 260,
  codFeeTaxMinor: 87,
  // TVA = linia (1.735) + transport (260) + taxa de ramburs (87)
  taxMinor: 2_082,
  totalMinor: 12_000,
  taxRateBps: 2100,
  shippingMethodCode: "courier",
  shippingSnapshot: { carrier: "demo" },
  paymentMethod: "cod",
  termsAcceptedAt: new Date(),
  termsConsentText: "Sunt de acord cu Termenii",
  termsConsentVersion: "provizoriu-1",
  idempotencyKey: randomUUID(),
  ...over,
});

const lineData = (
  orderId: string,
  variantId: string | null,
  over: Record<string, unknown> = {},
) => ({
  orderId,
  variantId,
  sku: "SKU-1",
  title: "Produs",
  quantity: 10_000n,
  unitSymbol: "buc",
  unitDecimals: 0,
  unitPriceMinor: 10_000,
  lineTotalMinor: 10_000,
  netMinor: 8_265,
  taxMinor: 1_735,
  taxRateBps: 2100,
  stockState: "in_stock",
  shippingClass: "standard",
  productSnapshot: { title: "Produs" },
  ...over,
});

async function attempt<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
): Promise<Error | null> {
  return inRolledBackTransaction(db, async (tx) => {
    const b = await setup(tx);
    try {
      await act(tx, b);
      return null;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

async function rejects<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
  expected: string,
): Promise<void> {
  const error = await attempt(setup, act);
  expect(error, `baza trebuia să respingă scrierea (${expected})`).not.toBeNull();
  expect(JSON.stringify(error) + String(error?.message)).toContain(expected);
}

async function accepts<B>(
  setup: (tx: TestTx) => Promise<B>,
  act: (tx: TestTx, b: B) => Promise<unknown>,
): Promise<void> {
  const error = await attempt(setup, act);
  expect(error, String(error?.message)).toBeNull();
}

describe("comanda: stări și sume", () => {
  it("acceptă o comandă validă", async () => {
    await accepts(base, (tx, b) => tx.order.create({ data: orderData(b.channel.id) }));
  });

  it("refuză o stare în afara listei, la fiecare dintre cele trei statusuri", async () => {
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { status: "x" }) }),
      "customer_order_status_check",
    );
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { paymentStatus: "x" }) }),
      "customer_order_payment_status_check",
    );
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { fulfillmentStatus: "x" }) }),
      "customer_order_fulfillment_status_check",
    );
  });

  it("refuză o metodă de plată necunoscută (cardul nu e încă o metodă)", async () => {
    await rejects(
      base,
      (tx, b) =>
        tx.order.create({
          data: orderData(b.channel.id, {
            paymentMethod: "card",
            codFeeMinor: 0,
            codFeeTaxMinor: 0,
            taxMinor: 1_995,
            totalMinor: 11_500,
            reservationExpiresAt: new Date(),
          }),
        }),
      "customer_order_payment_method_check",
    );
  });

  it("totalul trebuie să fie subtotal − reducere + transport + taxă de ramburs", async () => {
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { totalMinor: 12_001 }) }),
      "customer_order_total_check",
    );
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { totalMinor: 11_999 }) }),
      "customer_order_total_check",
    );
  });

  it("refuză sume negative și comanda de 0 lei", async () => {
    await rejects(
      base,
      (tx, b) =>
        tx.order.create({
          data: orderData(b.channel.id, { shippingMinor: -1, totalMinor: 10_499 }),
        }),
      "customer_order_amounts_check",
    );
    await rejects(
      base,
      (tx, b) =>
        tx.order.create({
          data: orderData(b.channel.id, {
            subtotalMinor: 0,
            shippingMinor: 0,
            codFeeMinor: 0,
            taxMinor: 0,
            totalMinor: 0,
          }),
        }),
      "customer_order_amounts_check",
    );
  });

  it("taxa de ramburs există doar la plata cu ramburs", async () => {
    await rejects(
      base,
      (tx, b) =>
        tx.order.create({
          data: orderData(b.channel.id, {
            paymentMethod: "bank_transfer",
            reservationExpiresAt: new Date(),
          }),
        }),
      "customer_order_cod_fee_check",
    );
  });

  it("rezervarea: transferul o cere, rambursul nu o are («una setată, una nulă»)", async () => {
    await rejects(
      base,
      (tx, b) =>
        tx.order.create({
          data: orderData(b.channel.id, {
            paymentMethod: "bank_transfer",
            codFeeMinor: 0,
            codFeeTaxMinor: 0,
            taxMinor: 1_995,
            totalMinor: 11_500,
          }),
        }),
      "customer_order_reservation_check",
    );
    await rejects(
      base,
      (tx, b) =>
        tx.order.create({ data: orderData(b.channel.id, { reservationExpiresAt: new Date() }) }),
      "customer_order_reservation_check",
    );
    await accepts(base, (tx, b) =>
      tx.order.create({
        data: orderData(b.channel.id, {
          paymentMethod: "bank_transfer",
          codFeeMinor: 0,
          codFeeTaxMinor: 0,
          taxMinor: 1_995,
          totalMinor: 11_500,
          reservationExpiresAt: new Date(),
        }),
      }),
    );
  });

  it("anularea: starea «cancelled» cere cancelledAt și invers", async () => {
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { status: "cancelled" }) }),
      "customer_order_cancelled_check",
    );
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { cancelledAt: new Date() }) }),
      "customer_order_cancelled_check",
    );
    await accepts(base, (tx, b) =>
      tx.order.create({
        data: orderData(b.channel.id, { status: "cancelled", cancelledAt: new Date() }),
      }),
    );
  });

  it("numărul și cheia de idempotență sunt unice", async () => {
    await rejects(
      async (tx) => {
        const b = await base(tx);
        const first = await tx.order.create({ data: orderData(b.channel.id) });
        return { b, first };
      },
      (tx, { b, first }) =>
        tx.order.create({
          data: orderData(b.channel.id, { number: first.number }),
        }),
      "number",
    );
    await rejects(
      async (tx) => {
        const b = await base(tx);
        const first = await tx.order.create({ data: orderData(b.channel.id) });
        return { b, first };
      },
      (tx, { b, first }) =>
        tx.order.create({
          data: orderData(b.channel.id, { idempotencyKey: first.idempotencyKey }),
        }),
      "idempotencyKey",
    );
  });

  it("contactul și consimțământul nu pot fi goale", async () => {
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { email: "  " }) }),
      "customer_order_contact_check",
    );
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { termsConsentText: "" }) }),
      "customer_order_contact_check",
    );
  });
});

describe("linia de comandă", () => {
  const withOrder = async (tx: TestTx) => {
    const b = await base(tx);
    const order = await tx.order.create({ data: orderData(b.channel.id) });
    return { ...b, order };
  };

  it("acceptă o linie validă", async () => {
    await accepts(withOrder, (tx, b) =>
      tx.orderLine.create({ data: lineData(b.order.id, b.variant.id) }),
    );
  });

  it("net + TVA trebuie să fie totalul liniei", async () => {
    await rejects(
      withOrder,
      (tx, b) =>
        tx.orderLine.create({ data: lineData(b.order.id, b.variant.id, { netMinor: 8_266 }) }),
      "order_line_total_check",
    );
  });

  it("cantitatea e pozitivă; sumele nenegative; zecimalele 0–4", async () => {
    for (const over of [{ quantity: 0n }, { unitPriceMinor: -1 }, { unitDecimals: 5 }]) {
      await rejects(
        withOrder,
        (tx, b) => tx.orderLine.create({ data: lineData(b.order.id, b.variant.id, over) }),
        "order_line_amounts_check",
      );
    }
  });

  it("termenul de livrare există doar la «La comandă» («una setată, una nulă»)", async () => {
    await rejects(
      withOrder,
      (tx, b) =>
        tx.orderLine.create({
          data: lineData(b.order.id, b.variant.id, { stockState: "on_order" }),
        }),
      "order_line_stock_state_check",
    );
    await rejects(
      withOrder,
      (tx, b) =>
        tx.orderLine.create({ data: lineData(b.order.id, b.variant.id, { leadTimeDays: 7 }) }),
      "order_line_stock_state_check",
    );
    await accepts(withOrder, (tx, b) =>
      tx.orderLine.create({
        data: lineData(b.order.id, b.variant.id, { stockState: "on_order", leadTimeDays: 14 }),
      }),
    );
  });

  it("clasa de transport e una dintre cele trei", async () => {
    await rejects(
      withOrder,
      (tx, b) =>
        tx.orderLine.create({ data: lineData(b.order.id, b.variant.id, { shippingClass: "xl" }) }),
      "order_line_shipping_class_check",
    );
  });

  it("o variantă apare o singură dată pe comandă", async () => {
    await rejects(
      async (tx) => {
        const b = await withOrder(tx);
        await tx.orderLine.create({ data: lineData(b.order.id, b.variant.id) });
        return b;
      },
      (tx, b) => tx.orderLine.create({ data: lineData(b.order.id, b.variant.id) }),
      "orderId",
    );
  });
});

describe("snapshot imuabil", () => {
  it("sumele comenzii nu se pot modifica după plasare, dar starea da", async () => {
    await rejects(
      async (tx) => {
        const b = await base(tx);
        return tx.order.create({ data: orderData(b.channel.id) });
      },
      (tx, order) =>
        tx.order.update({
          where: { id: order.id },
          data: { subtotalMinor: 9_000, totalMinor: 11_000 },
        }),
      "snapshot imuabil",
    );
    await accepts(
      async (tx) => {
        const b = await base(tx);
        return tx.order.create({ data: orderData(b.channel.id) });
      },
      (tx, order) =>
        tx.order.update({
          where: { id: order.id },
          data: { status: "confirmed", confirmedAt: new Date(), adminNote: "ok" },
        }),
    );
  });

  it("consimțământul și snapshot-ul livrării nu se pot modifica", async () => {
    for (const data of [
      { termsConsentText: "altceva" },
      { shippingSnapshot: { carrier: "altul" } },
      { paymentMethod: "bank_transfer" },
    ]) {
      await rejects(
        async (tx) => {
          const b = await base(tx);
          return tx.order.create({ data: orderData(b.channel.id) });
        },
        (tx, order) => tx.order.update({ where: { id: order.id }, data }),
        "snapshot imuabil",
      );
    }
  });

  it("linia nu se modifică, dar variantId devine NULL când varianta e ștearsă", async () => {
    await rejects(
      async (tx) => {
        const b = await base(tx);
        const order = await tx.order.create({ data: orderData(b.channel.id) });
        return tx.orderLine.create({ data: lineData(order.id, b.variant.id) });
      },
      (tx, line) =>
        tx.orderLine.update({
          where: { id: line.id },
          data: { lineTotalMinor: 1, netMinor: 1, taxMinor: 0 },
        }),
      "snapshot imuabil",
    );
    await accepts(
      async (tx) => {
        const b = await base(tx);
        const order = await tx.order.create({ data: orderData(b.channel.id) });
        const line = await tx.orderLine.create({ data: lineData(order.id, b.variant.id) });
        return { line, variantId: b.variant.id };
      },
      async (tx, { line, variantId }) => {
        await tx.productVariant.delete({ where: { id: variantId } });
        const after = await tx.orderLine.findUniqueOrThrow({ where: { id: line.id } });
        expect(after.variantId).toBeNull();
        expect(after.sku).toBe(line.sku);
      },
    );
  });
});

describe("adresa", () => {
  const addressData = (
    orderId: string,
    geo: Awaited<ReturnType<typeof siruta>>,
    over: Record<string, unknown> = {},
  ) => ({
    orderId,
    kind: "shipping",
    fullName: "Ion Popescu",
    phone: "0722000000",
    countyCode: geo.county.code,
    countyName: "Test",
    localityCode: geo.locality.code,
    localityName: "Sat Test",
    street: "Str. Exemplu 1",
    postalCode: "123456",
    ...over,
  });
  const withOrder = async (tx: TestTx) => {
    const b = await base(tx);
    const order = await tx.order.create({ data: orderData(b.channel.id) });
    return { ...b, order };
  };

  it("acceptă o adresă validă și refuză tipul necunoscut și codul poștal greșit", async () => {
    await accepts(withOrder, (tx, b) =>
      tx.address.create({ data: addressData(b.order.id, b.geo) }),
    );
    await rejects(
      withOrder,
      (tx, b) => tx.address.create({ data: addressData(b.order.id, b.geo, { kind: "x" }) }),
      "address_kind_check",
    );
    for (const postalCode of ["12345", "1234567", "12345a", ""]) {
      await rejects(
        withOrder,
        (tx, b) => tx.address.create({ data: addressData(b.order.id, b.geo, { postalCode }) }),
        "address_postal_code_check",
      );
    }
  });

  it("CUI-ul și starea verificării merg împreună («una setată, una nulă»)", async () => {
    await rejects(
      withOrder,
      (tx, b) => tx.address.create({ data: addressData(b.order.id, b.geo, { vatId: "RO123" }) }),
      "address_vat_check",
    );
    await rejects(
      withOrder,
      (tx, b) =>
        tx.address.create({
          data: addressData(b.order.id, b.geo, { vatIdVerification: "verified" }),
        }),
      "address_vat_check",
    );
    await rejects(
      withOrder,
      (tx, b) =>
        tx.address.create({
          data: addressData(b.order.id, b.geo, { vatId: "RO123", vatIdVerification: "poate" }),
        }),
      "address_vat_check",
    );
    await accepts(withOrder, (tx, b) =>
      tx.address.create({
        data: addressData(b.order.id, b.geo, { vatId: "RO123", vatIdVerification: "unverified" }),
      }),
    );
  });

  it("o singură adresă de fiecare tip pe comandă; adresa nu se modifică", async () => {
    await rejects(
      async (tx) => {
        const b = await withOrder(tx);
        await tx.address.create({ data: addressData(b.order.id, b.geo) });
        return b;
      },
      (tx, b) => tx.address.create({ data: addressData(b.order.id, b.geo) }),
      "orderId",
    );
    await rejects(
      async (tx) => {
        const b = await withOrder(tx);
        return tx.address.create({ data: addressData(b.order.id, b.geo) });
      },
      (tx, a) => tx.address.update({ where: { id: a.id }, data: { street: "Alta" } }),
      "snapshot imuabil",
    );
  });
});

describe("plata, livrarea, contorul și SIRUTA", () => {
  it("plata: furnizor, stare și sumă", async () => {
    const withOrder = async (tx: TestTx) => {
      const b = await base(tx);
      return tx.order.create({ data: orderData(b.channel.id) });
    };
    const pay = (orderId: string, over: Record<string, unknown> = {}) => ({
      orderId,
      provider: "cod",
      method: "cod",
      amountMinor: 12_000,
      ...over,
    });
    await accepts(withOrder, (tx, o) => tx.payment.create({ data: pay(o.id) }));
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { provider: "card" }) }),
      "payment_provider_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { status: "x" }) }),
      "payment_status_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { amountMinor: 0 }) }),
      "payment_amount_check",
    );
    await rejects(
      withOrder,
      (tx, o) => tx.payment.create({ data: pay(o.id, { status: "paid" }) }),
      "payment_captured_check",
    );
    await accepts(withOrder, (tx, o) =>
      tx.payment.create({ data: pay(o.id, { status: "paid", capturedAt: new Date() }) }),
    );
  });

  it("metoda de livrare: tip, sume nenegative, prag pozitiv sau nul; zona are cel puțin un județ", async () => {
    const method = (over: Record<string, unknown> = {}) => ({
      code: "courier",
      name: "Curier",
      type: "flat",
      priceMinor: 1_500,
      ...over,
    });
    await accepts(
      async () => null,
      (tx) => tx.shippingMethod.create({ data: method() }),
    );
    await rejects(
      async () => null,
      (tx) => tx.shippingMethod.create({ data: method({ type: "x" }) }),
      "shipping_method_type_check",
    );
    await rejects(
      async () => null,
      (tx) => tx.shippingMethod.create({ data: method({ priceMinor: -1 }) }),
      "shipping_method_amounts_check",
    );
    await rejects(
      async () => null,
      (tx) => tx.shippingMethod.create({ data: method({ freeAboveMinor: 0 }) }),
      "shipping_method_amounts_check",
    );
    await rejects(
      async () => null,
      (tx) => tx.shippingMethod.create({ data: method({ estimatedDays: -1 }) }),
      "shipping_method_amounts_check",
    );
    await rejects(
      async () => null,
      (tx) => tx.shippingZone.create({ data: { name: "Zonă", countyCodes: [] } }),
      "shipping_zone_counties_check",
    );
    await accepts(
      async () => null,
      (tx) => tx.shippingZone.create({ data: { name: "Zonă", countyCodes: [40, 23] } }),
    );
  });

  it("contorul: un singur rând «order», valoare nenegativă", async () => {
    await rejects(
      async () => null,
      (tx) => tx.orderCounter.create({ data: { id: "altul" } }),
      "order_counter_single_check",
    );
    await rejects(
      async () => null,
      async (tx) => {
        await tx.orderCounter.upsert({
          where: { id: "order" },
          create: { id: "order" },
          update: {},
        });
        await tx.orderCounter.update({ where: { id: "order" }, data: { lastValue: -1 } });
      },
      "order_counter_single_check",
    );
  });

  it("SIRUTA: județul fără părinte, UAT-ul și localitatea cu părinte («una setată, una nulă»)", async () => {
    const unit = (over: { level: number; tip?: number; parentCode: number | null }) => ({
      code: sirutaSeq++,
      countyCode: 99,
      name: "X",
      tip: 3,
      sourceVersion: "test",
      ...over,
    });
    await rejects(
      async () => null,
      (tx) => tx.sirutaUnit.create({ data: unit({ level: 1, tip: 40, parentCode: 1 }) }),
      "siruta_unit_level_check",
    );
    await rejects(
      async () => null,
      (tx) => tx.sirutaUnit.create({ data: unit({ level: 2, parentCode: null }) }),
      "siruta_unit_level_check",
    );
    await rejects(
      async () => null,
      (tx) => tx.sirutaUnit.create({ data: unit({ level: 4, parentCode: 1 }) }),
      "siruta_unit_level_check",
    );
  });
});

describe("cheia străină a stocului spre comandă", () => {
  async function stockBase(tx: TestTx) {
    const b = await base(tx);
    const warehouse = await tx.warehouse.create({ data: { code: `w_${uid()}`, name: "Depozit" } });
    await tx.inventoryItem.create({
      data: { variantId: b.variant.id, warehouseId: warehouse.id, physical: 50_000n },
    });
    const order = await tx.order.create({ data: orderData(b.channel.id) });
    return { ...b, warehouse, order };
  }
  const reservation = (
    b: Awaited<ReturnType<typeof stockBase>>,
    over: Record<string, unknown> = {},
  ) => ({
    variantId: b.variant.id,
    warehouseId: b.warehouse.id,
    quantity: 10_000n,
    refType: "order",
    refId: b.order.id,
    orderId: b.order.id,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  });
  const commitment = (
    b: Awaited<ReturnType<typeof stockBase>>,
    over: Record<string, unknown> = {},
  ) => ({
    variantId: b.variant.id,
    warehouseId: b.warehouse.id,
    quantity: 10_000n,
    refType: "order",
    refId: b.order.id,
    orderId: b.order.id,
    ...over,
  });

  it("acceptă referința de tip «order» cu orderId = refId și referințele generice fără orderId", async () => {
    await accepts(stockBase, (tx, b) => tx.stockReservation.create({ data: reservation(b) }));
    await accepts(stockBase, (tx, b) => tx.stockCommitment.create({ data: commitment(b) }));
    await accepts(stockBase, (tx, b) =>
      tx.stockReservation.create({
        data: reservation(b, { refType: "test", refId: "x", orderId: null }),
      }),
    );
    await accepts(stockBase, (tx, b) =>
      tx.stockCommitment.create({
        data: commitment(b, { refType: "test", refId: "x", orderId: null }),
      }),
    );
  });

  it("refuză «order» fără orderId, cu orderId diferit de refId, sau orderId la alt tip de referință", async () => {
    const cases: Array<Record<string, unknown>> = [
      { orderId: null },
      { refId: "alta" },
      { refType: "test", refId: "x" },
    ];
    for (const over of cases) {
      await rejects(
        stockBase,
        (tx, b) => tx.stockReservation.create({ data: reservation(b, over) }),
        "stock_reservation_order_ref_check",
      );
      await rejects(
        stockBase,
        (tx, b) => tx.stockCommitment.create({ data: commitment(b, over) }),
        "stock_commitment_order_ref_check",
      );
    }
  });

  it("refuză o comandă inexistentă (cheie străină) și blochează ștergerea comenzii cu stoc angajat", async () => {
    await rejects(
      stockBase,
      (tx, b) =>
        tx.stockCommitment.create({
          data: commitment(b, { refId: "nu-exista", orderId: "nu-exista" }),
        }),
      "stock_commitment_orderId_fkey",
    );
    await rejects(
      async (tx) => {
        const b = await stockBase(tx);
        await tx.stockCommitment.create({ data: commitment(b) });
        return b;
      },
      (tx, b) => tx.order.delete({ where: { id: b.order.id } }),
      "stock_commitment_orderId_fkey",
    );
  });
});

describe("integritatea totalurilor, verificată la commit", () => {
  const consistent = async (tx: TestTx) => {
    const b = await base(tx);
    const order = await tx.order.create({ data: orderData(b.channel.id) });
    await tx.orderLine.create({ data: lineData(order.id, b.variant.id) });
    return { ...b, order };
  };
  const check = (tx: TestTx) => tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");

  it("acceptă o comandă al cărei subtotal e suma liniilor și al cărei TVA e suma pe linii + transport + taxă", async () => {
    await accepts(consistent, (tx) => check(tx));
  });

  it("refuză o comandă fără nicio linie", async () => {
    await rejects(
      async (tx) => {
        const b = await base(tx);
        return tx.order.create({ data: orderData(b.channel.id) });
      },
      (tx) => check(tx),
      "nu are nicio linie",
    );
  });

  it("refuză un subtotal care nu e suma liniilor (1 ban diferență)", async () => {
    await rejects(
      async (tx) => {
        const b = await base(tx);
        const order = await tx.order.create({
          data: orderData(b.channel.id, {
            subtotalMinor: 10_001,
            totalMinor: 12_001,
            taxMinor: 2_082,
          }),
        });
        await tx.orderLine.create({ data: lineData(order.id, b.variant.id) });
      },
      (tx) => check(tx),
      "nu e suma liniilor",
    );
  });

  it("refuză un TVA al comenzii diferit cu 1 ban de suma TVA-urilor pe linii + transport + taxă", async () => {
    for (const taxMinor of [2_081, 2_083]) {
      await rejects(
        async (tx) => {
          const b = await base(tx);
          const order = await tx.order.create({
            data: orderData(b.channel.id, { taxMinor }),
          });
          await tx.orderLine.create({ data: lineData(order.id, b.variant.id) });
        },
        (tx) => check(tx),
        "TVA-ul",
      );
    }
  });

  it("refuză ștergerea unei linii dintr-o comandă existentă", async () => {
    await rejects(
      async (tx) => {
        const b = await consistent(tx);
        await check(tx);
        return b;
      },
      async (tx, b) => {
        await tx.orderLine.deleteMany({ where: { orderId: b.order.id } });
        await check(tx);
      },
      "nu are nicio linie",
    );
  });

  it("TVA-ul transportului și al taxei nu pot depăși sumele lor", async () => {
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { shippingTaxMinor: 1_501 }) }),
      "customer_order_tax_parts_check",
    );
    await rejects(
      base,
      (tx, b) => tx.order.create({ data: orderData(b.channel.id, { codFeeTaxMinor: 501 }) }),
      "customer_order_tax_parts_check",
    );
  });

  it("șterge o comandă cu liniile ei fără să se plângă de integritate", async () => {
    await accepts(consistent, async (tx, b) => {
      await check(tx);
      await tx.order.delete({ where: { id: b.order.id } });
      await check(tx);
    });
  });
});
