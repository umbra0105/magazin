import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { DemoInvoiceProvider } from "@ecom/integrations";
import type { AccountUser } from "../account/order-ownership";
import { InvoiceService, type InvoiceProviderSource } from "../invoicing/invoice-service";
import { confirmBankTransferPayment } from "../orders/order-payments";
import { LOYALTY_PORTS, transitionOrder } from "../orders/order-service";
import { requestOrderRefund, type OrderRefundDeps } from "../payments/order-refund";
import { confirmManualRefund } from "../payments/refund-service";
import {
  approveReturn,
  inspectReturn,
  markReturnReceived,
  setReturnAwb,
} from "../returns/return-admin";
import { initiateReturn } from "../returns/return-customer";
import { buildRefundProposal, refundReturn } from "../returns/return-refund";
import { NOW, codeOf, harness, orderOf, type Harness } from "../test-utils/checkout-fixtures";
import { addTo, destination, type World } from "../test-utils/digital-checkout";
import { loyaltyWorld, setSetting } from "../test-utils/loyalty-fixtures";
import { adjustPoints, readBalance } from "./ledger";
import { orderLoyaltyView } from "./loyalty-read";
import { grantDuePoints, pendingPoints, syncOrderLoyalty } from "./order-loyalty";

/**
 * Returul și rambursarea unei comenzi cu puncte (Faza 15b), pe Postgres real (tranzacție anulată, cu verificările de la COMMIT
 * forțate), cu facturarea SIMULATĂ pornită. Comanda de bază: linia A 2 × 50,00 lei, linia B 1 × 50,00 lei, curier. Cu 90 de
 * puncte reducerea se împarte 60,00 (A) + 30,00 (B). Rambursarea face doar bani; punctele se întorc ca puncte; suma
 * stornourilor este totalul facturii, la ban.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY = 86_400_000;
const ADMIN = { label: "admin@test.ro" };
const env = { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" };

const force = async (h: Harness) => {
  await h.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
  await h.tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
};

interface Scene {
  h: Harness;
  world: World;
  service: InvoiceService;
  /** Trece timpul pentru coada de facturi. */
  advance: (milliseconds: number) => void;
}

/**
 * Procesează coada de facturi până se golește, cu ceasul injectat care avansează. Un lot ia proforma și factura împreună, iar
 * baza nu garantează ordinea în care le întoarce: luată prima, factura se reprogramează peste un minut (ca în producție).
 */
async function issueDue(s: Scene) {
  for (let round = 0; round < 3; round++) {
    await s.service.processDue();
    s.advance(2 * 60_000);
  }
}

async function scene(fn: (s: Scene) => Promise<void>, options: { invoicing?: boolean } = {}) {
  await harness(async (h) => {
    const world = await loyaltyWorld(h, 500);
    if (options.invoicing !== false) await setSetting(h.tx, "invoicing.provider", "demo");
    const demo = new DemoInvoiceProvider({ env, now: () => NOW });
    const source: InvoiceProviderSource = {
      active: async () => "demo",
      provider: async () => demo,
    };
    let clock = NOW.getTime() + 60_000;
    const service = new InvoiceService({
      db: h.tx as unknown as PrismaClient,
      source,
      now: () => new Date(clock),
    });
    const advance = (milliseconds: number) => {
      clock += milliseconds;
    };
    await fn({ h, world, service, advance });
    await force(h);
  });
}

/**
 * Livrarea prin tranzițiile reale (curier sau ridicare). Momentul evenimentului îl pune baza (ceasul real), de aceea e mutat
 * relativ la ceasul injectat (cu o zi în urmă), iar punctele se reașază pe el.
 */
async function deliver(h: Harness, orderId: string) {
  for (const [fulfillmentStatus, type] of [
    ["fulfilled", "fulfillment.step"],
    ["in_transit", "order.shipped"],
    ["delivered", "order.delivered"],
  ] as const) {
    await transitionOrder(
      h.tx,
      orderId,
      { fulfillmentStatus },
      { type, message: "livrare de test" },
      NOW,
    );
  }
  await h.tx.orderEvent.updateMany({
    where: { orderId, type: "order.delivered" },
    data: { createdAt: new Date(NOW.getTime() - DAY) },
  });
  await syncOrderLoyalty(h.tx, orderId, NOW, LOYALTY_PORTS);
}

interface Placed {
  orderId: string;
  user: AccountUser;
  /** id-urile liniilor, după prețul unitar și cantitate: A (2 bucăți), B (1 bucată). */
  a: string;
  b: string;
  shippingMinor: number;
  totalMinor: number;
}

/** Comandă cu A (2 × `unit`) și B (1 × `unit`), transfer confirmat și livrată (curier consemnat sau ridicată). */
async function delivered(
  s: Scene,
  options: { points?: number; unit?: number; pickup?: boolean } = {},
): Promise<Placed> {
  const { h, world } = s;
  const unit = options.unit ?? 5_000;
  const a = await h.product({ price: unit });
  const b = await h.product({ price: unit });
  await addTo(world, [{ variantId: a.variantId, quantity: "2" }, { variantId: b.variantId }]);
  const first = await h.checkout.preview({
    owner: world.owner,
    destination: destination(h),
    paymentMethod: "bank_transfer",
  });
  const offer = first.shipping!.offers.find((o) =>
    options.pickup ? o.kind === "pickup" : o.kind !== "pickup",
  )!;
  const preview = await h.checkout.preview({
    owner: world.owner,
    destination: destination(h),
    offerCode: offer.code,
    paymentMethod: "bank_transfer",
    ...(options.points ? { loyaltyPoints: options.points } : {}),
  });
  const input = await h.input(world.owner, {
    paymentMethod: "bank_transfer",
    shippingOfferCode: offer.code,
    expectedTotalMinor: preview.totals!.totalMinor,
    ...(options.points ? { loyaltyPoints: options.points } : {}),
  });
  const placed = await h.checkout.place(world.owner, input);
  await force(h);
  await confirmBankTransferPayment(h.tx, placed.orderId, { now: NOW });
  await issueDue(s);
  await deliver(h, placed.orderId);
  const order = await orderOf(h.tx, placed.orderId);
  // retururile se fac de proprietarul comenzii: emailul comenzii, verificat
  const user = await h.tx.user.create({
    data: {
      id: `u_${randomUUID().slice(0, 12)}`,
      name: "Client",
      email: order.email,
      emailVerified: true,
    },
  });
  const sku = (productSku: string) => order.lines.find((l) => l.sku === productSku)!.id;
  return {
    orderId: placed.orderId,
    user: { id: user.id, email: user.email, emailVerified: true },
    a: sku(a.sku),
    b: sku(b.sku),
    shippingMinor: order.shippingMinor,
    totalMinor: order.totalMinor,
  };
}

const refundDeps = (h: Harness): OrderRefundDeps => ({
  db: h.tx,
  getProvider: async () => null,
  now: () => NOW,
  readLimitMinor: async () => null,
});

/** Cere și inspectează un retur cu liniile date (linie → număr de bucăți). */
async function inspected(s: Scene, p: Placed, items: Array<[string, string]>) {
  const { h } = s;
  const created = await initiateReturn(
    h.tx,
    p.user,
    {
      orderId: p.orderId,
      clientKey: randomUUID(),
      items: items.map(([orderLineId, quantity]) => ({
        orderLineId,
        quantity,
        reasonCode: "changed_mind",
      })),
    },
    NOW,
  );
  await approveReturn(h.tx, created.returnId, ADMIN, NOW);
  await setReturnAwb(h.tx, created.returnId, ADMIN, { carrier: "Curier", awb: "AWB1" }, NOW);
  await markReturnReceived(h.tx, created.returnId, ADMIN, NOW);
  const rows = await h.tx.returnItem.findMany({ where: { returnId: created.returnId } });
  await inspectReturn(
    h.tx,
    created.returnId,
    ADMIN,
    rows.map((row) => ({
      returnItemId: row.id,
      acceptedQuantity: String(Number(row.requestedQty) / 10_000),
      condition: "as_new",
      resellable: true,
    })),
    NOW,
  );
  return created.returnId;
}

const refund = (
  h: Harness,
  returnId: string,
  extra: { shippingMinor?: number; shippingReason?: string } = {},
) =>
  refundReturn(refundDeps(h), {
    returnId,
    actorLabel: ADMIN.label,
    actorUnlimited: true,
    ...extra,
  });

async function refundAndConfirm(
  h: Harness,
  returnId: string,
  extra: { shippingMinor?: number; shippingReason?: string } = {},
) {
  const result = await refund(h, returnId, extra);
  if (result.refundId) {
    await confirmManualRefund(refundDeps(h), {
      refundId: result.refundId,
      reference: "ext-1",
      actorLabel: ADMIN.label,
    });
  }
  await force(h);
  return result;
}

const returnRow = (h: Harness, id: string) =>
  h.tx.returnRequest.findUniqueOrThrow({ where: { id }, include: { items: true } });

const pointsRows = async (h: Harness, orderId: string) =>
  (await h.tx.loyaltyTransaction.findMany({ where: { orderId }, orderBy: { seq: "asc" } })).map(
    (row) => `${row.type}:${row.points}`,
  );

async function invoiceDocs(h: Harness, orderId: string) {
  const docs = await h.tx.invoice.findMany({
    where: { orderId, kind: { in: ["invoice", "storno"] }, status: { not: "skipped" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const invoice = docs.find((d) => d.kind === "invoice")!;
  return { invoice, stornos: docs.filter((d) => d.kind === "storno") };
}

/** Stornoul restului (anulare/refuz din admin): după el, suma stornourilor trebuie să fie factura. */
async function reverseRest(s: Scene, p: Placed) {
  await s.service.requestReverse(p.orderId, "admin");
  await issueDue(s);
  const { invoice, stornos } = await invoiceDocs(s.h, p.orderId);
  expect(stornos.map((d) => d.status)).toEqual(stornos.map(() => "issued"));
  expect(stornos.reduce((sum, d) => sum + d.totalMinor, 0)).toBe(invoice.totalMinor);
}

describe("retur parțial cu puncte", () => {
  it("banii = brutul liniei minus partea de puncte; punctele se întorc ca puncte; stornoul e exact", async () => {
    await scene(async (s) => {
      const { h, world } = s;
      const p = await delivered(s, { points: 90 });
      expect(p.totalMinor).toBe(6_000 + p.shippingMinor);

      const first = await inspected(s, p, [[p.a, "1"]]);
      // o bucată din A: 50,00 − floor(60,00 × 50 / 100) = 50,00 − 30,00 = 20,00 lei în bani
      expect(await buildRefundProposal(h.tx, first)).toMatchObject({
        productsMinor: 2_000,
        loyaltyDiscountMinor: 3_000,
      });
      const result = await refundAndConfirm(h, first);
      expect(result.amountMinor).toBe(2_000);
      expect(await returnRow(h, first)).toMatchObject({
        status: "refunded",
        refundProductsMinor: 2_000,
        stornoState: "queued",
        items: [{ refundLineMinor: 2_000, loyaltyDiscountMinor: 3_000 }],
      });
      expect(await readBalance(h.tx, world.userId)).toBe(500 - 90 + 30);

      const second = await inspected(s, p, [
        [p.a, "1"],
        [p.b, "1"],
      ]);
      expect((await refundAndConfirm(h, second)).amountMinor).toBe(4_000);
      // toată reducerea întoarsă → toate punctele
      expect(await readBalance(h.tx, world.userId)).toBe(500);
      expect(await pointsRows(h, p.orderId)).toEqual(["redeem:-90", "release:30", "release:60"]);

      await issueDue(s);
      const { stornos } = await invoiceDocs(h, p.orderId);
      expect(stornos.map((d) => d.totalMinor)).toEqual([2_000, 4_000]);
      await reverseRest(s, p);
    });
  });

  it("transportul rambursat într-un retur nu schimbă punctele și nu scade baza de acumulare", async () => {
    await scene(async (s) => {
      const { h, world } = s;
      const p = await delivered(s, { unit: 100_000 });
      const id = await inspected(s, p, [[p.b, "1"]]);
      await refundAndConfirm(h, id, { shippingMinor: p.shippingMinor, shippingReason: "defect" });
      const [pending] = await pendingPoints(h.tx, world.userId);
      // 2.000,00 lei rămași în bani pe produse → 20 de puncte
      expect(pending?.points).toBe(20);
    });
  });
});

describe("retur cu 0 lei de rambursat (linia plătită integral cu puncte)", () => {
  it("se închide fără rambursare de plată: puncte întoarse, storno în coadă și emis, de 0 lei", async () => {
    await scene(async (s) => {
      const { h, world } = s;
      const p = await delivered(s, { points: 150 });
      // în bani rămâne doar transportul
      expect(p.totalMinor).toBe(p.shippingMinor);
      const id = await inspected(s, p, [[p.b, "1"]]);
      expect(await refund(h, id)).toEqual({
        refundId: null,
        created: false,
        amountMinor: 0,
        productsMinor: 0,
        shippingMinor: 0,
      });
      await force(h);
      expect(await returnRow(h, id)).toMatchObject({
        status: "refunded",
        refundId: null,
        refundProductsMinor: 0,
        refundShippingMinor: 0,
        stornoState: "queued",
        items: [{ refundLineMinor: 0, loyaltyDiscountMinor: 5_000 }],
      });
      expect(await h.tx.refund.count({ where: { orderId: p.orderId } })).toBe(0);
      expect((await orderOf(h.tx, p.orderId)).paymentStatus).toBe("paid");
      expect(await readBalance(h.tx, world.userId)).toBe(400);

      // dublu clic: același rezultat, fără alte efecte
      expect((await refund(h, id)).refundId).toBeNull();
      expect(await pointsRows(h, p.orderId)).toEqual(["redeem:-150", "release:50"]);

      await issueDue(s);
      const { stornos } = await invoiceDocs(h, p.orderId);
      expect(stornos.map((d) => [d.status, d.totalMinor, d.taxMinor])).toEqual([["issued", 0, 0]]);

      const rest = await inspected(s, p, [[p.a, "2"]]);
      expect((await refundAndConfirm(h, rest)).refundId).toBeNull();
      expect(await readBalance(h.tx, world.userId)).toBe(500);
      await issueDue(s);
      await reverseRest(s, p);
    });
  });

  it("cu transport rambursat manual rămâne o rambursare obișnuită (bani > 0)", async () => {
    await scene(async (s) => {
      const { h } = s;
      const p = await delivered(s, { points: 150 });
      const id = await inspected(s, p, [[p.b, "1"]]);
      const result = await refundAndConfirm(h, id, {
        shippingMinor: p.shippingMinor,
        shippingReason: "produs defect",
      });
      expect(result.refundId).not.toBeNull();
      expect(result.amountMinor).toBe(p.shippingMinor);
      expect(await returnRow(h, id)).toMatchObject({ status: "refunded", refundProductsMinor: 0 });
    });
  });

  it("cu facturarea oprită: închis, fără storno de emis", async () => {
    await scene(
      async (s) => {
        const p = await delivered(s, { points: 150 });
        const id = await inspected(s, p, [[p.b, "1"]]);
        await refund(s.h, id);
        expect(await returnRow(s.h, id)).toMatchObject({
          status: "refunded",
          stornoState: "not_needed",
        });
      },
      { invoicing: false },
    );
  });

  it("cu facturarea pornită și factura neemisă: refuzat, ca la orice retur", async () => {
    await scene(async (s) => {
      const p = await delivered(s, { points: 150 });
      const id = await inspected(s, p, [[p.b, "1"]]);
      await s.h.tx.invoice.deleteMany({ where: { orderId: p.orderId } });
      expect(await codeOf(refund(s.h, id))).toBe("RETURN_REFUND_INVOICE_PENDING");
      expect((await returnRow(s.h, id)).status).toBe("inspected");
    });
  });
});

describe("punctele acordate și retururile", () => {
  const grant = (h: Harness, now: Date) => grantDuePoints(h.tx, { now, ports: LOYALTY_PORTS });
  const due = async (h: Harness, orderId: string) =>
    (await h.tx.order.findUniqueOrThrow({ where: { id: orderId } })).loyaltyEarnDueAt!;

  it("cât returul e deschis, acordarea așteaptă; după retur se acordă doar pe liniile păstrate", async () => {
    await scene(async (s) => {
      const { h, world } = s;
      const p = await delivered(s, { unit: 100_000, pickup: true });
      const when = await due(h, p.orderId);
      const id = await inspected(s, p, [[p.b, "1"]]);
      expect((await grant(h, when)).granted).toBe(0);
      await refundAndConfirm(h, id);
      expect(await grant(h, when)).toMatchObject({ granted: 1, points: 20 });
      expect(await readBalance(h.tx, world.userId)).toBe(520);
    });
  });

  it("retur după acordare: revocare pe liniile returnate", async () => {
    await scene(async (s) => {
      const { h, world } = s;
      const p = await delivered(s, { unit: 100_000, pickup: true });
      await grant(h, await due(h, p.orderId));
      expect(await readBalance(h.tx, world.userId)).toBe(530);
      await refundAndConfirm(h, await inspected(s, p, [[p.a, "1"]]));
      expect(await readBalance(h.tx, world.userId)).toBe(520);
      expect(await pointsRows(h, p.orderId)).toEqual(["earn:30", "revoke:-10"]);
    });
  });

  it("retur după ce punctele au fost cheltuite: sold negativ, folosirea blocată", async () => {
    await scene(async (s) => {
      const { h, world } = s;
      const p = await delivered(s, { unit: 100_000, pickup: true });
      await grant(h, await due(h, p.orderId));
      // cheltuie tot soldul (500 de pornire + 30) printr-o ajustare de test
      await adjustPoints(h.tx, {
        customerId: world.userId,
        points: -530,
        reason: "consum de test",
        actorId: "u_test",
        expiresAt: NOW,
        now: NOW,
        key: randomUUID(),
      });
      await refundAndConfirm(h, await inspected(s, p, [[p.a, "2"]]));
      expect(await readBalance(h.tx, world.userId)).toBe(-20);
      const product = await h.product({ price: 50_000 });
      await addTo(world, [{ variantId: product.variantId }]);
      const preview = await h.checkout.preview({
        owner: world.owner,
        destination: destination(h),
        loyaltyPoints: 10,
      });
      expect(preview.loyalty).toMatchObject({ balance: -20, redeem: null, appliedPoints: 0 });
      const input = await h.input(world.owner, { loyaltyPoints: 10 });
      expect(await codeOf(h.checkout.place(world.owner, input))).toBe("ORDER_POINTS_INVALID");
    });
  });

  const freeRefund = async (h: Harness, orderId: string, amountMinor: number) => {
    const r = await requestOrderRefund(refundDeps(h), {
      orderId,
      amountMinor,
      reason: "compensație",
      idempotencyKey: `liber:${randomUUID()}`,
      actorLabel: ADMIN.label,
      actorUnlimited: true,
    });
    await confirmManualRefund(refundDeps(h), {
      refundId: r.refundId,
      reference: "x",
      actorLabel: ADMIN.label,
    });
    await force(h);
  };

  it("rambursare parțială de bani în afara unui retur: scade punctele de primit; punctele folosite rămân", async () => {
    await scene(
      async (s) => {
        const { h, world } = s;
        const p = await delivered(s, { unit: 100_000, points: 100, pickup: true });
        // 3.000 − 100 = 2.900 lei în bani → 29; după 50 lei rambursați → 28
        expect((await pendingPoints(h.tx, world.userId))[0]?.points).toBe(29);
        await freeRefund(h, p.orderId, 5_000 * 1);
        expect((await pendingPoints(h.tx, world.userId))[0]?.points).toBe(28);
        expect(await pointsRows(h, p.orderId)).toEqual(["redeem:-100"]);
        await grant(h, await due(h, p.orderId));
        await freeRefund(h, p.orderId, 10_000);
        expect(await pointsRows(h, p.orderId)).toEqual(["redeem:-100", "earn:28", "revoke:-1"]);
      },
      { invoicing: false },
    );
  });

  it("rambursare integrală în afara unui retur: se rambursează doar banii, iar punctele se întorc ca puncte", async () => {
    await scene(
      async (s) => {
        const { h, world } = s;
        const p = await delivered(s, { points: 90 });
        await freeRefund(h, p.orderId, p.totalMinor);
        expect(
          (await h.tx.refund.findMany({ where: { orderId: p.orderId } })).map((r) => r.amountMinor),
        ).toEqual([p.totalMinor]);
        expect(await readBalance(h.tx, world.userId)).toBe(500);
        expect(await pointsRows(h, p.orderId)).toEqual(["redeem:-90", "release:90"]);
      },
      { invoicing: false },
    );
  });

  it("mai multe bucăți fracționare ale aceleiași linii: banii adunați = banii liniei, punctele = cele folosite", async () => {
    await scene(
      async (s) => {
        const { h, world } = s;
        const p = await delivered(s, { unit: 3_333, points: 49 });
        const one = await inspected(s, p, [[p.a, "1"]]);
        const first = await refundAndConfirm(h, one);
        const two = await inspected(s, p, [[p.a, "1"]]);
        const second = await refundAndConfirm(h, two);
        const three = await inspected(s, p, [[p.b, "1"]]);
        const third = await refundAndConfirm(h, three);
        expect(first.amountMinor + second.amountMinor + third.amountMinor).toBe(3 * 3_333 - 4_900);
        expect(await readBalance(h.tx, world.userId)).toBe(500);
      },
      { invoicing: false },
    );
  });
});

describe("factura emisă a unei comenzi cu puncte (simulată)", () => {
  it("rândurile salvate: produse la prețul întreg, câte un rând de reducere; totalul și TVA-ul sunt ale comenzii", async () => {
    await scene(async (s) => {
      const p = await delivered(s, { points: 90 });
      const order = await orderOf(s.h.tx, p.orderId);
      const invoice = await s.h.tx.invoice.findUniqueOrThrow({
        where: { orderId_docKey: { orderId: p.orderId, docKey: "invoice" } },
        include: { lines: { orderBy: { position: "asc" } } },
      });
      expect(invoice).toMatchObject({
        status: "issued",
        simulated: true,
        totalMinor: order.totalMinor,
        taxMinor: order.taxMinor,
        lastErrorCode: null,
      });
      expect(invoice.lines.map((l) => [l.kind, l.lineTotalMinor])).toEqual([
        ["product", 10_000],
        ["discount", 6_000],
        ["product", 5_000],
        ["discount", 3_000],
        ["shipping", p.shippingMinor],
      ]);
      const signed = (pick: (l: (typeof invoice.lines)[number]) => number) =>
        invoice.lines.reduce((sum, l) => sum + (l.kind === "discount" ? -pick(l) : pick(l)), 0);
      expect(signed((l) => l.lineTotalMinor)).toBe(order.totalMinor);
      expect(signed((l) => l.taxMinor)).toBe(order.taxMinor);
    });
  });
});

describe("punctele unei comenzi, în contul clientului", () => {
  it("folosite și de primit cu data, apoi primite; alt cont nu vede nimic", async () => {
    await scene(async (s) => {
      const p = await delivered(s, { points: 90, unit: 100_000 });
      const buyer = s.world.userId;
      const waiting = await orderLoyaltyView(s.h.tx, p.orderId, buyer);
      const [row] = await pendingPoints(s.h.tx, buyer);
      expect(waiting).toEqual({
        pointsUsed: 90,
        earned: null,
        toEarn: { points: 29, availableAt: row!.availableAt },
      });
      expect(await orderLoyaltyView(s.h.tx, p.orderId, p.user.id)).toBeNull();
      await grantDuePoints(s.h.tx, {
        now: new Date(row!.availableAt.getTime() + 1_000),
        ports: LOYALTY_PORTS,
      });
      expect(await orderLoyaltyView(s.h.tx, p.orderId, buyer)).toEqual({
        pointsUsed: 90,
        earned: 29,
        toEarn: null,
      });
    });
  });
});
