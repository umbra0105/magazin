import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  removeAllE2eDemoPayments,
  removeAllE2eOrders,
  removeE2eCartStock,
  removeE2eDemoPayments,
  removeE2eDemoProvider,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eDemoPayments,
  setE2eCartStock,
  type E2eCartProduct,
} from "./e2e-support";

/**
 * Curățarea E2E a comenzilor (mini-faza `e2e-curatare-comenzi`). Cauza dovedită a intermitenței din `checkout.spec.ts:146`:
 * `removeE2eOrders()` șterga TOATE comenzile cu emailul `@e2e-comanda.invalid`, deci `afterAll`-ul unui fișier lovea comanda în lucru
 * a altui fișier, rulat în paralel. Aici, pe Postgres real (date comise, fișier separat, fără presupuneri de seed):
 *  1. `removeE2eOrders({ tag })` șterge DOAR comenzile acelui tag, cu tot ce atârnă de ele (linii, plăți, rezervări, oferte, notificări);
 *  2. comenzile altui tag rămân întregi, inclusiv când tag-urile se potrivesc parțial (sufix, prefix, tag în prefixul emailului);
 *  3. `removeE2eDemoPayments({ tag })` șterge doar rambursările și evenimentele plăților acelor comenzi, nu starea comună;
 *  4. ștergerea GLOBALĂ (`removeAllE2eOrders`, `removeAllE2eDemoPayments`) e o funcție distinctă, pentru setup/teardown.
 */
const db = getDb();

const HASH = "a".repeat(64);
const hex = (length = 6) => randomBytes(length).toString("hex").slice(0, length);
const channelCode = `e2e_ch_${hex()}`;
let channelId = "";
let restoreDefaultWarehouse: () => Promise<void> = async () => undefined;
let defaultWarehouseId = "";
const products: E2eCartProduct[] = [];
const foreignEmail = `strain-${hex()}@example.test`;
const foreignOrderNumber = `E2E-STRAIN-${hex()}`;

beforeAll(async () => {
  const channel = await db.salesChannel.create({ data: { code: channelCode, name: "Canal E2E" } });
  channelId = channel.id;
  const existing = await db.warehouse.findFirst({ where: { isDefault: true } });
  if (existing) {
    defaultWarehouseId = existing.id;
    return;
  }
  const created = await db.warehouse.create({
    data: { code: `w_e2e${hex(4)}`, name: "Implicit temporar", isDefault: true },
  });
  defaultWarehouseId = created.id;
  restoreDefaultWarehouse = async () => {
    await db.warehouse.update({ where: { id: created.id }, data: { isDefault: false } });
    await db.warehouse.delete({ where: { id: created.id } });
  };
});

/** Curățare tolerantă: o funcție lipsă sau un eșec nu are voie să lase restul rândurilor în baza de test. */
const quiet = (fn: () => Promise<unknown>) =>
  Promise.resolve()
    .then(fn)
    .catch(() => undefined);

afterAll(async () => {
  await quiet(() => removeAllE2eDemoPayments());
  await quiet(() => removeAllE2eOrders());
  await db.order.deleteMany({ where: { number: foreignOrderNumber } });
  await quiet(() => removeE2eCartStock(products.map((product) => product.variantId)));
  await quiet(() => removeE2eProducts());
  await quiet(() => db.salesChannel.delete({ where: { id: channelId } }));
  await quiet(() => restoreDefaultWarehouse());
  await db.$disconnect();
});

interface Seeded {
  email: string;
  orderId: string;
  paymentId: string;
  refundId: string;
  eventId: string;
  offerId: string;
  notificationKey: string;
  reservationId: string;
}

function bareOrder(email: string, number: string) {
  return db.order.create({
    data: {
      number,
      channelId,
      email,
      phone: "0700000000",
      subtotalMinor: 1000,
      shippingMinor: 0,
      taxMinor: 174,
      totalMinor: 1000,
      taxRateBps: 2100,
      shippingMethodCode: "courier",
      shippingSnapshot: {},
      paymentMethod: "card",
      reservationExpiresAt: new Date(Date.now() + 900_000),
      paymentRetryDeadlineAt: new Date(Date.now() + 86_400_000),
      termsAcceptedAt: new Date(),
      termsConsentText: "Termeni",
      termsConsentVersion: "1",
      idempotencyKey: `idem-${number}`,
      lines: {
        create: {
          sku: "E2E-LINIE",
          title: "Linie E2E",
          quantity: 10_000n,
          unitSymbol: "buc",
          unitDecimals: 0,
          unitPriceMinor: 1000,
          lineTotalMinor: 1000,
          netMinor: 826,
          taxMinor: 174,
          taxRateBps: 2100,
          stockState: "in_stock",
          shippingClass: "standard",
          productSnapshot: {},
        },
      },
    },
  });
}

/** O comandă E2E completă, cu tot ce atârnă de ea: plată, rambursare, eveniment webhook, ofertă, notificare și rezervare. */
async function seedOrder(email: string): Promise<Seeded> {
  const suffix = hex(8);
  const order = await bareOrder(email, `E2E-${suffix}`);
  const payment = await db.payment.create({
    data: { orderId: order.id, provider: "demo", method: "card", amountMinor: 1000 },
  });
  const refund = await db.refund.create({
    data: {
      paymentId: payment.id,
      orderId: order.id,
      amountMinor: 500,
      reason: "test",
      kind: "admin",
      idempotencyKey: `refund-${suffix}`,
    },
  });
  const event = await db.paymentWebhookEvent.create({
    data: {
      provider: "demo",
      eventId: `ev-${suffix}`,
      bodyHash: HASH,
      processedAt: new Date(),
      paymentId: payment.id,
      status: "processed",
    },
  });
  const offer = await db.orderOffer.create({
    data: {
      number: `OF-${suffix}`,
      tokenHash: `${suffix}${"b".repeat(56)}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      creatorId: "e2e",
      creatorLabel: "E2E",
      email,
      phone: "0700000000",
      shipping: {},
      shippingOfferCode: "courier",
      shippingKind: "courier",
      subtotalMinor: 1000,
      shippingMinor: 0,
      taxMinor: 0,
      totalMinor: 1000,
      taxRateBps: 2100,
    },
  });
  const notificationKey = `offer_test:${offer.id}`;
  await db.adminNotification.create({
    data: {
      kind: "offer_test",
      title: "Test",
      href: "/admin/comenzi",
      permission: "orders.read",
      dedupKey: notificationKey,
    },
  });
  const product = await seedE2eCartProduct(hex(), `cur${hex(3)}`, { price: 19_900 });
  products.push(product);
  await setE2eCartStock(product.variantId, "5");
  const reservation = await db.stockReservation.create({
    data: {
      variantId: product.variantId,
      warehouseId: defaultWarehouseId,
      quantity: 10_000n,
      refType: "order",
      refId: order.id,
      orderId: order.id,
      expiresAt: new Date(Date.now() + 900_000),
    },
  });
  return {
    email,
    orderId: order.id,
    paymentId: payment.id,
    refundId: refund.id,
    eventId: event.id,
    offerId: offer.id,
    notificationKey,
    reservationId: reservation.id,
  };
}

async function presence(seeded: Seeded) {
  return {
    order: await db.order.count({ where: { id: seeded.orderId } }),
    payment: await db.payment.count({ where: { id: seeded.paymentId } }),
    refund: await db.refund.count({ where: { id: seeded.refundId } }),
    event: await db.paymentWebhookEvent.count({ where: { id: seeded.eventId } }),
    offer: await db.orderOffer.count({ where: { id: seeded.offerId } }),
    notification: await db.adminNotification.count({ where: { dedupKey: seeded.notificationKey } }),
    reservation: await db.stockReservation.count({ where: { id: seeded.reservationId } }),
  };
}

const ALL = {
  order: 1,
  payment: 1,
  refund: 1,
  event: 1,
  offer: 1,
  notification: 1,
  reservation: 1,
};
const NONE = {
  order: 0,
  payment: 0,
  refund: 0,
  event: 0,
  offer: 0,
  notification: 0,
  reservation: 0,
};

describe("tag-ul curățării: obligatoriu și validat ca la removeE2eStock", () => {
  it.each(["", "%", "ab", "abcdefabcdefa", "ABC123", "xyz123", "abc_12", "a b c", "%-abc123"])(
    "refuză tag-ul «%s», înainte de orice interogare",
    async (tag) => {
      await expect(removeE2eOrders({ tag })).rejects.toThrow(/hexazecimal/);
      await expect(removeE2eDemoPayments({ tag })).rejects.toThrow(/hexazecimal/);
    },
  );

  it("fără tag nu se poate apela (eroare de tip și de execuție)", async () => {
    // @ts-expect-error tag-ul e obligatoriu: fără el, funcția nu are voie să șteargă nimic
    await expect(removeE2eOrders()).rejects.toThrow(/hexazecimal/);
    // @ts-expect-error tag-ul e obligatoriu
    await expect(removeE2eOrders({})).rejects.toThrow(/hexazecimal/);
    // @ts-expect-error tag-ul e obligatoriu
    await expect(removeE2eDemoPayments()).rejects.toThrow(/hexazecimal/);
  });
});

describe("curățarea pe tag: nu o atinge pe cea a altui tag (cursa din checkout.spec.ts:146)", () => {
  it("șterge comanda tag-ului și tot ce atârnă de ea; comanda altui tag rămâne întreagă", async () => {
    const tagA = hex();
    const tagB = hex();
    const a = await seedOrder(`client-${tagA}${E2E_ORDER_EMAIL_DOMAIN}`);
    const b = await seedOrder(`client-${tagB}${E2E_ORDER_EMAIL_DOMAIN}`);
    expect(await presence(a)).toEqual(ALL);
    expect(await presence(b)).toEqual(ALL);

    await removeE2eDemoPayments({ tag: tagA });
    await removeE2eOrders({ tag: tagA });

    expect(await presence(a)).toEqual(NONE);
    expect(await presence(b)).toEqual(ALL);
  });

  it("tag-urile care se potrivesc parțial nu se ating: sufix, prefix și tag în prefixul emailului", async () => {
    // `c123` e sufix al lui `abc123`; emailul lui `abc123` are și `-c123-` în prefix
    const long = "abc123";
    const short = "c123";
    const withLong = await seedOrder(`flux-${short}-${long}${E2E_ORDER_EMAIL_DOMAIN}`);
    const plainLong = await seedOrder(`client-${long}${E2E_ORDER_EMAIL_DOMAIN}`);
    const withShort = await seedOrder(`client-${short}${E2E_ORDER_EMAIL_DOMAIN}`);

    await removeE2eDemoPayments({ tag: short });
    await removeE2eOrders({ tag: short });
    expect(await presence(withShort)).toEqual(NONE);
    expect(await presence(withLong)).toEqual(ALL);
    expect(await presence(plainLong)).toEqual(ALL);

    await removeE2eDemoPayments({ tag: long });
    await removeE2eOrders({ tag: long });
    expect(await presence(withLong)).toEqual(NONE);
    expect(await presence(plainLong)).toEqual(NONE);
  });

  it("aceeași comandă cu mai multe prefixe (checkout: client-, dublu-, pret-…) pleacă toată odată", async () => {
    const tag = hex();
    const first = await seedOrder(`client-${tag}${E2E_ORDER_EMAIL_DOMAIN}`);
    const second = await seedOrder(`dublu-${tag}${E2E_ORDER_EMAIL_DOMAIN}`);
    const other = await seedOrder(`client-${hex()}${E2E_ORDER_EMAIL_DOMAIN}`);
    await removeE2eDemoPayments({ tag });
    await removeE2eOrders({ tag });
    expect(await presence(first)).toEqual(NONE);
    expect(await presence(second)).toEqual(NONE);
    expect(await presence(other)).toEqual(ALL);
    await removeAllE2eDemoPayments();
    await removeAllE2eOrders();
  });
});

describe("plățile DEMO: partea pe tag și partea globală", () => {
  it("removeE2eDemoPayments({ tag }) nu atinge integrarea DEMO, setarea furnizorului sau evenimentele altor comenzi", async () => {
    await seedE2eDemoPayments();
    const tagA = hex();
    const tagB = hex();
    const a = await seedOrder(`card-${tagA}${E2E_ORDER_EMAIL_DOMAIN}`);
    const b = await seedOrder(`card-${tagB}${E2E_ORDER_EMAIL_DOMAIN}`);
    // eveniment respins, fără plată: nu se poate lega de nicio comandă
    const orphan = await db.paymentWebhookEvent.create({
      data: {
        provider: "demo",
        eventId: `orfan-${hex(8)}`,
        bodyHash: HASH,
        processedAt: new Date(),
        status: "rejected",
        rejectReason: "signature",
      },
    });

    await removeE2eDemoPayments({ tag: tagA });

    const integration = await db.integration.count({
      where: { type: "payment", provider: "demo" },
    });
    const provider = await db.setting.count({ where: { key: "payment.cardProvider" } });
    expect(integration).toBe(1);
    expect(provider).toBe(1);
    expect(await db.refund.count({ where: { id: a.refundId } })).toBe(0);
    expect(await db.paymentWebhookEvent.count({ where: { id: a.eventId } })).toBe(0);
    expect(await db.refund.count({ where: { id: b.refundId } })).toBe(1);
    expect(await db.paymentWebhookEvent.count({ where: { id: b.eventId } })).toBe(1);
    expect(await db.paymentWebhookEvent.count({ where: { id: orphan.id } })).toBe(1);

    await removeE2eOrders({ tag: tagA });
    expect(await presence(a)).toEqual(NONE);
    expect(await presence(b)).toEqual(ALL);

    // partea globală: integrarea, setarea și evenimentele neatașabile
    await removeAllE2eDemoPayments();
    expect(await db.integration.count({ where: { type: "payment" } })).toBe(0);
    expect(await db.setting.count({ where: { key: "payment.cardProvider" } })).toBe(0);
    expect(await db.paymentWebhookEvent.count({ where: { id: orphan.id } })).toBe(0);
    await removeAllE2eDemoPayments();
    await removeAllE2eOrders();
  });
});

describe("starea comună DEMO: removeE2eDemoProvider", () => {
  it("șterge DOAR rândul de integrare de plată și alegerea furnizorului; comenzile, rambursările și evenimentele rămân", async () => {
    await seedE2eDemoPayments();
    const seeded = await seedOrder(`card-${hex()}${E2E_ORDER_EMAIL_DOMAIN}`);
    expect(await db.integration.count({ where: { type: "payment" } })).toBeGreaterThan(0);
    expect(await db.setting.count({ where: { key: "payment.cardProvider" } })).toBe(1);

    await removeE2eDemoProvider();

    expect(await db.integration.count({ where: { type: "payment" } })).toBe(0);
    expect(await db.setting.count({ where: { key: "payment.cardProvider" } })).toBe(0);
    expect(await presence(seeded)).toEqual(ALL);

    // idempotentă: a doua oară nu mai are ce șterge și nu dă eroare
    await expect(removeE2eDemoProvider()).resolves.toBeUndefined();
    await removeAllE2eDemoPayments();
    await removeAllE2eOrders();
  });
});

describe("curățarea globală (doar pentru setup/teardown)", () => {
  it("removeAllE2eOrders() șterge comenzile E2E ale tuturor tag-urilor, nu și comenzile cu alt domeniu", async () => {
    const a = await seedOrder(`client-${hex()}${E2E_ORDER_EMAIL_DOMAIN}`);
    const b = await seedOrder(`flux-x-${hex()}${E2E_ORDER_EMAIL_DOMAIN}`);
    const foreign = await bareOrder(foreignEmail, foreignOrderNumber);

    await removeAllE2eDemoPayments();
    await removeAllE2eOrders();

    expect(await presence(a)).toEqual(NONE);
    expect(await presence(b)).toEqual(NONE);
    expect(await db.order.count({ where: { id: foreign.id } })).toBe(1);
  });
});
