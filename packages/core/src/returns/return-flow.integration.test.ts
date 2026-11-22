import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { DemoInvoiceProvider } from "@ecom/integrations";
import { NOW, codeOf, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import type { AccountUser } from "../account/order-ownership";
import { InvoiceService, type InvoiceProviderSource } from "../invoicing/invoice-service";
import { confirmManualRefund } from "../payments/refund-service";
import type { OrderRefundDeps } from "../payments/order-refund";
import {
  approveReturn,
  inspectReturn,
  markReturnReceived,
  rejectReturn,
  setReturnAwb,
} from "./return-admin";
import { cancelReturnByCustomer, initiateReturn } from "./return-customer";
import { refundReturn } from "./return-refund";
import { restockReturn } from "./return-restock";

/**
 * Faza 14, fluxul de retur pe Postgres real (tranzacție anulată): proprietate, fereastra de retur cu ceas injectat, cantități,
 * idempotență, rambursarea (doar produsele, serviciul din Faza 10), încheierea returului la confirmarea rambursării, stornoul
 * parțial la ban, repunerea pe stoc o singură dată. Ceasul e injectat (`NOW`); evenimentele de livrare se calculează relativ la el.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = { label: "admin@test.ro" };
const env = { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" };

async function setting(h: Harness, key: string, value: unknown) {
  await h.tx.setting.upsert({
    where: { key },
    create: { key, group: key.split(".")[0] as string, value: value as never },
    update: { value: value as never },
  });
}

interface Placed {
  orderId: string;
  lineId: string;
  user: AccountUser;
  unitMinor: number;
  lineTotalMinor: number;
  variantId: string;
}

/** O comandă cu 3 bucăți, plătită (ramburs încasat), livrată acum `deliveredDaysAgo` zile; clientul are email verificat. */
async function placed(
  h: Harness,
  opts: {
    deliveredDaysAgo?: number | null;
    verified?: boolean;
    managed?: boolean;
    physical?: string;
  } = {},
): Promise<Placed> {
  const product = await h.product({
    ...(opts.managed === false ? { manageStock: false } : {}),
    ...(opts.physical ? { physical: opts.physical } : {}),
  });
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("3") }]);
  const { orderId } = await h.checkout.place(owner, await h.input(owner));
  const order = await h.tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true },
  });
  const line = order.lines[0]!;
  const payment = await h.tx.payment.findFirst({ where: { orderId } });
  if (payment) {
    await h.tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "paid",
        capturedAt: new Date(NOW.getTime() - DAY),
        capturedAmountMinor: payment.amountMinor,
        capturedCurrency: "RON",
      },
    });
  } else {
    await h.tx.payment.create({
      data: {
        orderId,
        provider: "cod",
        method: "cod",
        amountMinor: order.totalMinor,
        status: "paid",
        capturedAt: new Date(NOW.getTime() - DAY),
        capturedAmountMinor: order.totalMinor,
        capturedCurrency: "RON",
      },
    });
  }
  await h.tx.order.update({ where: { id: orderId }, data: { paymentStatus: "paid" } });
  if (opts.deliveredDaysAgo !== null) {
    await h.tx.orderEvent.create({
      data: {
        orderId,
        type: "order.delivered",
        message: "Livrată",
        createdAt: new Date(NOW.getTime() - (opts.deliveredDaysAgo ?? 1) * DAY),
      },
    });
  }
  const user =
    (await h.tx.user.findUnique({ where: { email: order.email } })) ??
    (await h.tx.user.create({
      data: {
        id: `u_${randomUUID().slice(0, 8)}`,
        name: "Client",
        email: order.email,
        emailVerified: opts.verified ?? true,
      },
    }));
  return {
    orderId,
    lineId: line.id,
    user: { id: user.id, email: user.email, emailVerified: user.emailVerified },
    unitMinor: line.unitPriceMinor,
    lineTotalMinor: line.lineTotalMinor,
    variantId: product.variantId,
  };
}

const init = (h: Harness, p: Placed, quantity: string, over: Record<string, unknown> = {}) =>
  initiateReturn(
    h.tx,
    p.user,
    {
      orderId: p.orderId,
      clientKey: randomUUID(),
      items: [{ orderLineId: p.lineId, quantity, reasonCode: "changed_mind" }],
      ...over,
    },
    NOW,
  );

const refundDeps = (h: Harness): OrderRefundDeps => ({
  db: h.tx,
  getProvider: async () => null,
  now: () => NOW,
  readLimitMinor: async () => null,
});

/** De la cerere la inspectat, cu tot ce s-a cerut acceptat și revandabil. */
async function toInspected(h: Harness, returnId: string, acceptedOver?: string, resellable = true) {
  await approveReturn(h.tx, returnId, ADMIN, NOW);
  await setReturnAwb(h.tx, returnId, ADMIN, { carrier: "Curier", awb: "AWB1" }, NOW);
  await markReturnReceived(h.tx, returnId, ADMIN, NOW);
  const items = await h.tx.returnItem.findMany({ where: { returnId } });
  await inspectReturn(
    h.tx,
    returnId,
    ADMIN,
    items.map((i) => ({
      returnItemId: i.id,
      acceptedQuantity: acceptedOver ?? String(Number(i.requestedQty) / 10_000),
      condition: "as_new",
      resellable,
    })),
    NOW,
  );
}

/** Rambursarea pornită (în așteptare manuală) și apoi confirmată de admin: returul trebuie să se încheie. */
async function refundAndConfirm(
  h: Harness,
  returnId: string,
  extra: { shippingMinor?: number; shippingReason?: string } = {},
) {
  const result = await refundReturn(refundDeps(h), {
    returnId,
    actorLabel: ADMIN.label,
    actorUnlimited: true,
    ...extra,
  });
  await confirmManualRefund(refundDeps(h), {
    refundId: result.refundId,
    reference: "ext-1",
    actorLabel: ADMIN.label,
  });
  return result;
}

describe("proprietatea comenzii", () => {
  it("un alt client nu poate iniția retur pe comanda altuia (se comportă ca una inexistentă)", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const stranger = await h.tx.user.create({
        data: {
          id: `u_${randomUUID().slice(0, 8)}`,
          name: "Alt client",
          email: "altcineva@exemplu.ro",
          emailVerified: true,
        },
      });
      const code = await codeOf(
        init(
          h,
          { ...p, user: { id: stranger.id, email: stranger.email, emailVerified: true } },
          "1",
        ),
      );
      expect(code).toBe("RETURN_NOT_FOUND");
    });
  });

  it("emailul necerificat nu primește comenzile de oaspete; cel verificat le primește (comparație normalizată)", async () => {
    await harness(async (h) => {
      const p = await placed(h, { verified: false });
      expect(await codeOf(init(h, p, "1"))).toBe("RETURN_NOT_FOUND");
      const verified: AccountUser = {
        ...p.user,
        email: "  CLIENT@exemplu.ro ",
        emailVerified: true,
      };
      const ok = await init(h, { ...p, user: verified }, "1");
      expect(ok.created).toBe(true);
    });
  });

  it("o comandă legată prin customerId e a clientului chiar dacă emailul diferă", async () => {
    await harness(async (h) => {
      const p = await placed(h, { verified: false });
      await h.tx.order.update({ where: { id: p.orderId }, data: { customerId: p.user.id } });
      expect((await init(h, p, "1")).created).toBe(true);
    });
  });

  it("un cont anonimizat nu mai are comenzi", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const code = await codeOf(init(h, { ...p, user: { ...p.user, anonymizedAt: NOW } }, "1"));
      expect(code).toBe("RETURN_NOT_FOUND");
    });
  });

  it("clientul nu poate anula returul altuia", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "1");
      const other: AccountUser = { id: "alt-cont", email: "x@y.ro", emailVerified: true };
      expect(await codeOf(cancelReturnByCustomer(h.tx, other, r.returnId, NOW))).toBe(
        "RETURN_NOT_FOUND",
      );
      await cancelReturnByCustomer(h.tx, p.user, r.returnId, NOW);
      const row = await h.tx.returnRequest.findUniqueOrThrow({ where: { id: r.returnId } });
      expect(row.status).toBe("cancelled");
    });
  });
});

describe("fereastra de retur (ceas injectat)", () => {
  it("fără livrare consemnată nu se poate iniția returul", async () => {
    await harness(async (h) => {
      const p = await placed(h, { deliveredDaysAgo: null });
      expect(await codeOf(init(h, p, "1"))).toBe("RETURN_ORDER_NOT_ELIGIBLE");
    });
  });

  it("14 zile de la livrare: deschis la 13 zile, închis la 15", async () => {
    await harness(async (h) => {
      expect((await init(h, await placed(h, { deliveredDaysAgo: 13 }), "1")).created).toBe(true);
    });
    await harness(async (h) => {
      expect(await codeOf(init(h, await placed(h, { deliveredDaysAgo: 15 }), "1"))).toBe(
        "RETURN_WINDOW_EXPIRED",
      );
    });
  });

  it("fereastra vine din setare, nu din cod: cu 30 de zile, o livrare de acum 20 de zile merge", async () => {
    await harness(async (h) => {
      const p = await placed(h, { deliveredDaysAgo: 20 });
      expect(await codeOf(init(h, p, "1"))).toBe("RETURN_WINDOW_EXPIRED");
      await setting(h, "returns.windowDays", 30);
      expect((await init(h, p, "1")).created).toBe(true);
    });
  });

  it("ridicarea personală: momentul marcat ca ridicat (order.picked_up) pornește fereastra", async () => {
    await harness(async (h) => {
      const p = await placed(h, { deliveredDaysAgo: null });
      await h.tx.orderEvent.create({
        data: {
          orderId: p.orderId,
          type: "order.picked_up",
          message: "Ridicată",
          createdAt: new Date(NOW.getTime() - 2 * DAY),
        },
      });
      expect((await init(h, p, "1")).created).toBe(true);
    });
  });
});

describe("cantități și idempotență", () => {
  it("nu se poate returna mai mult decât a rămas; restul se poate returna", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      expect(await codeOf(init(h, p, "4"))).toBe("RETURN_QUANTITY_EXCEEDED");
      await init(h, p, "2");
      expect(await codeOf(init(h, p, "2"))).toBe("RETURN_QUANTITY_EXCEEDED");
      expect((await init(h, p, "1")).created).toBe(true);
      expect(await codeOf(init(h, p, "1"))).toBe("RETURN_QUANTITY_EXCEEDED");
    });
  });

  it("cantitate zero, negativă sau cu zecimale la o unitate întreagă: refuz", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      for (const bad of ["0", "-1", "1,5", "abc", ""]) {
        expect(await codeOf(init(h, p, bad)), bad).toBe("RETURN_QUANTITY_INVALID");
      }
    });
  });

  it("dublu-click: aceeași cheie întoarce același retur, fără al doilea", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const clientKey = randomUUID();
      const a = await init(h, p, "1", { clientKey });
      const b = await init(h, p, "1", { clientKey });
      expect(b).toEqual({ returnId: a.returnId, number: a.number, created: false });
      expect(await h.tx.returnRequest.count({ where: { orderId: p.orderId } })).toBe(1);
    });
  });

  it("motiv necunoscut, «altul» fără text, linie străină, linie dublată: refuz", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const other = await placed(h);
      const base = { orderId: p.orderId, clientKey: randomUUID() };
      const attempt = (items: object[]) =>
        codeOf(
          initiateReturn(
            h.tx,
            p.user,
            { ...base, clientKey: randomUUID(), items: items as never },
            NOW,
          ),
        );
      expect(
        await attempt([{ orderLineId: p.lineId, quantity: "1", reasonCode: "capriciu" }]),
      ).toBe("RETURN_INPUT_INVALID");
      expect(await attempt([{ orderLineId: p.lineId, quantity: "1", reasonCode: "other" }])).toBe(
        "RETURN_INPUT_INVALID",
      );
      expect(
        await attempt([{ orderLineId: other.lineId, quantity: "1", reasonCode: "defective" }]),
      ).toBe("RETURN_INPUT_INVALID");
      expect(
        await attempt([
          { orderLineId: p.lineId, quantity: "1", reasonCode: "defective" },
          { orderLineId: p.lineId, quantity: "1", reasonCode: "defective" },
        ]),
      ).toBe("RETURN_INPUT_INVALID");
      expect(await attempt([])).toBe("RETURN_NOTHING_RETURNABLE");
    });
  });
});

describe("rambursarea returului: doar produsele, prin serviciul din Faza 10", () => {
  it("suma = produsele acceptate; transportul NU se adaugă singur; returul se încheie la confirmare", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId);
      const result = await refundAndConfirm(h, r.returnId);
      expect(result.productsMinor).toBe(p.unitMinor);
      expect(result.shippingMinor).toBe(0);
      expect(result.amountMinor).toBe(p.unitMinor);
      const ret = await h.tx.returnRequest.findUniqueOrThrow({
        where: { id: r.returnId },
        include: { items: true },
      });
      expect(ret.status).toBe("refunded");
      expect(ret.refundId).toBe(result.refundId);
      expect(ret.refundProductsMinor).toBe(p.unitMinor);
      expect(ret.items[0]?.refundLineMinor).toBe(p.unitMinor);
      const refund = await h.tx.refund.findUniqueOrThrow({ where: { id: result.refundId } });
      expect(refund.amountMinor).toBe(p.unitMinor);
      expect(refund.idempotencyKey).toBe(`return:${r.returnId}`);
      expect(ret.stornoState).toBe("not_needed");
    });
  });

  it("două retururi succesive: sumele rambursărilor adunate = totalul liniei, exact (ultima bucată ia restul)", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const a = await init(h, p, "1");
      await toInspected(h, a.returnId);
      const ra = await refundAndConfirm(h, a.returnId);
      const b = await init(h, p, "2");
      await toInspected(h, b.returnId);
      const rb = await refundAndConfirm(h, b.returnId);
      expect(ra.productsMinor + rb.productsMinor).toBe(p.lineTotalMinor);
    });
  });

  it("transportul se adaugă doar manual, cu motiv, și nu depășește transportul plătit", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
      expect(order.shippingMinor).toBeGreaterThan(0);
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId);
      const input = { returnId: r.returnId, actorLabel: ADMIN.label, actorUnlimited: true };
      expect(await codeOf(refundReturn(refundDeps(h), { ...input, shippingMinor: 100 }))).toBe(
        "RETURN_REFUND_INVALID",
      );
      expect(
        await codeOf(
          refundReturn(refundDeps(h), {
            ...input,
            shippingMinor: order.shippingMinor + 1,
            shippingReason: "Produs defect",
          }),
        ),
      ).toBe("RETURN_REFUND_INVALID");
      const ok = await refundAndConfirm(h, r.returnId, {
        shippingMinor: order.shippingMinor,
        shippingReason: "Produs defect",
      });
      expect(ok.amountMinor).toBe(p.unitMinor + order.shippingMinor);
      const ret = await h.tx.returnRequest.findUniqueOrThrow({ where: { id: r.returnId } });
      expect(ret.refundShippingMinor).toBe(order.shippingMinor);
      expect(ret.refundShippingReason).toBe("Produs defect");
    });
  });

  it("dublu-click pe «Rambursează»: o singură rambursare, aceeași sumă", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId);
      const input = { returnId: r.returnId, actorLabel: ADMIN.label, actorUnlimited: true };
      const first = await refundReturn(refundDeps(h), input);
      const second = await refundReturn(refundDeps(h), input);
      expect(second.refundId).toBe(first.refundId);
      expect(second.created).toBe(false);
      expect(await h.tx.refund.count({ where: { orderId: p.orderId } })).toBe(1);
    });
  });

  it("nu se rambursează înainte de inspecție, nici un retur cu zero bucăți acceptate", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "1");
      const input = { returnId: r.returnId, actorLabel: ADMIN.label, actorUnlimited: true };
      expect(await codeOf(refundReturn(refundDeps(h), input))).toBe("RETURN_STATE_INVALID");
      await toInspected(h, r.returnId, "0", false);
      expect(await codeOf(refundReturn(refundDeps(h), input))).toBe("RETURN_REFUND_INVALID");
    });
  });

  it("a doua rambursare de retur pe aceeași comandă așteaptă până se încheie prima", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const a = await init(h, p, "1");
      const b = await init(h, p, "1");
      await toInspected(h, a.returnId);
      await toInspected(h, b.returnId);
      const first = await refundReturn(refundDeps(h), {
        returnId: a.returnId,
        actorLabel: ADMIN.label,
        actorUnlimited: true,
      });
      const input = { returnId: b.returnId, actorLabel: ADMIN.label, actorUnlimited: true };
      expect(await codeOf(refundReturn(refundDeps(h), input))).toBe("RETURN_REFUND_PENDING_OTHER");
      await confirmManualRefund(refundDeps(h), {
        refundId: first.refundId,
        reference: "x",
        actorLabel: ADMIN.label,
      });
      expect((await refundReturn(refundDeps(h), input)).created).toBe(true);
    });
  });

  it("rolul cu limită (Suport) nu poate depăși limita de rambursare, prin același serviciu", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "3");
      await toInspected(h, r.returnId);
      const deps = { ...refundDeps(h), readLimitMinor: async () => 1_000 };
      const code = await codeOf(
        refundReturn(deps, {
          returnId: r.returnId,
          actorLabel: "suport@test.ro",
          actorUnlimited: false,
        }),
      );
      expect(code).toBe("REFUND_OVER_LIMIT");
      expect(await h.tx.refund.count({ where: { orderId: p.orderId } })).toBe(0);
    });
  });

  it("respingerea după inspecție: nicio rambursare, cantitatea revine în joc", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "3");
      await toInspected(h, r.returnId, "0", false);
      await rejectReturn(h.tx, r.returnId, ADMIN, "Produsele nu corespund", NOW);
      const row = await h.tx.returnRequest.findUniqueOrThrow({ where: { id: r.returnId } });
      expect(row.status).toBe("rejected");
      expect(row.rejectReason).toBe("Produsele nu corespund");
      expect((await init(h, p, "3")).created).toBe(true);
    });
  });
});

describe("repunerea pe stoc: o singură dată", () => {
  const physicalOf = async (h: Harness, variantId: string) =>
    (await h.tx.inventoryItem.findFirstOrThrow({ where: { variantId } })).physical;

  it("liniile revandabile se repun, o singură dată; a doua apăsare nu mută nimic", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const before = await physicalOf(h, p.variantId);
      const r = await init(h, p, "2");
      await toInspected(h, r.returnId);
      const first = await restockReturn(h.tx, r.returnId, ADMIN, NOW);
      expect(first.restocked).toBe(1);
      expect(await physicalOf(h, p.variantId)).toBe(before + 20_000n);
      const second = await restockReturn(h.tx, r.returnId, ADMIN, NOW);
      expect(second).toMatchObject({ restocked: 0, alreadyRestocked: 1 });
      expect(await physicalOf(h, p.variantId)).toBe(before + 20_000n);
      const movements = await h.tx.stockMovement.findMany({
        where: { variantId: p.variantId, reason: "return" },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]?.deltaPhysical).toBe(20_000n);
    });
  });

  it("o linie nerevandabilă nu se repune; cantitatea acceptată se repune, nu cea cerută", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const before = await physicalOf(h, p.variantId);
      const r = await init(h, p, "3");
      await toInspected(h, r.returnId, "1", true);
      await restockReturn(h.tx, r.returnId, ADMIN, NOW);
      expect(await physicalOf(h, p.variantId)).toBe(before + 10_000n);
    });
    await harness(async (h) => {
      const p = await placed(h);
      const before = await physicalOf(h, p.variantId);
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId, "1", false);
      const out = await restockReturn(h.tx, r.returnId, ADMIN, NOW);
      expect(out).toMatchObject({ restocked: 0, notResellable: 1 });
      expect(await physicalOf(h, p.variantId)).toBe(before);
    });
  });

  it("produsele fără stoc gestionat nu au nicio acțiune de stoc și rămân nemarcate", async () => {
    await harness(async (h) => {
      const p = await placed(h, { managed: false });
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId);
      const out = await restockReturn(h.tx, r.returnId, ADMIN, NOW);
      expect(out).toMatchObject({ restocked: 0, notManaged: 1 });
      expect(
        await h.tx.stockMovement.count({ where: { variantId: p.variantId, reason: "return" } }),
      ).toBe(0);
      const item = await h.tx.returnItem.findFirstOrThrow({ where: { returnId: r.returnId } });
      expect(item.restockedAt).toBeNull();
    });
  });

  it("nu se repune înainte de inspecție", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "1");
      expect(await codeOf(restockReturn(h.tx, r.returnId, ADMIN, NOW))).toBe(
        "RETURN_RESTOCK_INVALID",
      );
    });
  });
});

describe("stornoul parțial la rambursare: aceleași sume, la ban", () => {
  async function withInvoicing(fn: (h: Harness, service: InvoiceService) => Promise<void>) {
    await harness(
      async (h) => {
        await setting(h, "invoicing.provider", "demo");
        const demo = new DemoInvoiceProvider({ env, now: () => NOW });
        const source: InvoiceProviderSource = {
          active: async () => "demo",
          provider: async () => demo,
        };
        const service = new InvoiceService({
          db: h.tx as unknown as PrismaClient,
          source,
          now: () => new Date(NOW.getTime() + 60_000),
        });
        await fn(h, service);
      },
      { settings: { cardProvider: { code: "demo", mode: "demo" } } },
    );
  }

  it("cu facturarea activă și factura neemisă, rambursarea e refuzată", async () => {
    await withInvoicing(async (h) => {
      const p = await placed(h);
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId);
      expect(
        await codeOf(
          refundReturn(refundDeps(h), {
            returnId: r.returnId,
            actorLabel: ADMIN.label,
            actorUnlimited: true,
          }),
        ),
      ).toBe("RETURN_REFUND_INVOICE_PENDING");
    });
  });

  it("două retururi: stornourile au exact sumele rambursărilor, iar suma lor = totalul liniei", async () => {
    await withInvoicing(async (h, service) => {
      const p = await placed(h);
      await service.processDue();
      const a = await init(h, p, "1");
      await toInspected(h, a.returnId);
      const ra = await refundAndConfirm(h, a.returnId);
      const b = await init(h, p, "2");
      await toInspected(h, b.returnId);
      const rb = await refundAndConfirm(h, b.returnId);
      const stornos = await h.tx.invoice.findMany({
        where: { orderId: p.orderId, kind: "storno" },
        orderBy: { createdAt: "asc" },
      });
      expect(stornos.map((s) => s.totalMinor)).toEqual([ra.productsMinor, rb.productsMinor]);
      expect(stornos.reduce((s, d) => s + d.totalMinor, 0)).toBe(p.lineTotalMinor);
      const ra2 = await h.tx.returnRequest.findUniqueOrThrow({ where: { id: a.returnId } });
      expect(ra2.stornoState).toBe("queued");
      // transportul nu se stornează automat
      const lines = await h.tx.invoiceLine.findMany({
        where: { invoiceId: { in: stornos.map((s) => s.id) } },
      });
      expect(lines.every((l) => l.kind === "product")).toBe(true);
    });
  });

  it("rambursarea care ar completa suma plătită după un storno parțial e refuzată", async () => {
    await withInvoicing(async (h, service) => {
      const p = await placed(h);
      await service.processDue();
      const a = await init(h, p, "1");
      await toInspected(h, a.returnId);
      await refundAndConfirm(h, a.returnId);
      const b = await init(h, p, "2");
      await toInspected(h, b.returnId);
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
      // fără taxă de ramburs în plata din test: transportul rambursat manual ridică rambursarea la întreaga sumă plătită
      await h.tx.payment.updateMany({
        where: { orderId: p.orderId },
        data: {
          amountMinor: p.lineTotalMinor + order.shippingMinor,
          capturedAmountMinor: p.lineTotalMinor + order.shippingMinor,
        },
      });
      const code = await codeOf(
        refundReturn(refundDeps(h), {
          returnId: b.returnId,
          actorLabel: ADMIN.label,
          actorUnlimited: true,
          shippingMinor: order.shippingMinor,
          shippingReason: "Produs defect",
        }),
      );
      expect(code).toBe("RETURN_REFUND_COMPLETES_ORDER");
    });
  });

  it("o diferență între rambursare și storno NU trece: stornoul nu se emite, returul ia «failed»", async () => {
    await withInvoicing(async (h, service) => {
      const p = await placed(h);
      await service.processDue();
      const a = await init(h, p, "1");
      await toInspected(h, a.returnId);
      // stricăm în mod deliberat suma salvată pe retur, ca stornoul să iasă diferit
      const result = await refundReturn(refundDeps(h), {
        returnId: a.returnId,
        actorLabel: ADMIN.label,
        actorUnlimited: true,
      });
      await h.tx.returnRequest.update({
        where: { id: a.returnId },
        data: { refundProductsMinor: result.productsMinor + 1 },
      });
      await confirmManualRefund(refundDeps(h), {
        refundId: result.refundId,
        reference: "x",
        actorLabel: ADMIN.label,
      });
      const ret = await h.tx.returnRequest.findUniqueOrThrow({ where: { id: a.returnId } });
      expect(ret.status).toBe("refunded");
      expect(ret.stornoState).toBe("failed");
      expect(await h.tx.invoice.count({ where: { orderId: p.orderId, kind: "storno" } })).toBe(0);
    });
  });
});

describe("returul parțial nu mută comanda în «returned»", () => {
  it("după rambursare, starea comenzii rămâne neschimbată (în afara plății)", async () => {
    await harness(async (h) => {
      const p = await placed(h);
      const before = await h.tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
      const r = await init(h, p, "1");
      await toInspected(h, r.returnId);
      await refundAndConfirm(h, r.returnId);
      const after = await h.tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
      expect(after.status).toBe(before.status);
      expect(after.fulfillmentStatus).toBe(before.fulfillmentStatus);
      expect(after.paymentStatus).toBe("partially_refunded");
    });
  });
});
