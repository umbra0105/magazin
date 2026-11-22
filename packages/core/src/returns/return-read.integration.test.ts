import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { NOW, codeOf, harness, q, type Harness } from "../test-utils/checkout-fixtures";
import type { AccountUser } from "../account/order-ownership";
import { approveReturn, setReturnAdminNote } from "./return-admin";
import { initiateReturn } from "./return-customer";
import {
  getAdminReturn,
  getCustomerReturn,
  listAdminReturns,
  listCustomerReturns,
  listOrderReturns,
  returnReasonReport,
} from "./return-read";

/**
 * Citirile retururilor pe Postgres real (tranzacție anulată): clientul vede doar returul lui și nimic intern; adminul vede tot;
 * raportul de motive numără retururi, linii și bucăți. Ceasul e injectat.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = { label: "admin@test.ro" };
const SECRET = "NOTA-INTERNA-SECRETA";

async function setup(h: Harness, email: string, reason = "defective", quantity = "1") {
  const product = await h.product();
  const owner = await h.fill([{ variantId: product.variantId, quantity: q("3") }]);
  const { orderId } = await h.checkout.place(
    owner,
    await h.input(owner, { contact: { email, phone: "0722123456" } }),
  );
  await h.tx.orderEvent.create({
    data: {
      orderId,
      type: "order.delivered",
      message: "Livrată",
      createdAt: new Date(NOW.getTime() - DAY),
    },
  });
  const line = await h.tx.orderLine.findFirstOrThrow({ where: { orderId } });
  const user =
    (await h.tx.user.findUnique({ where: { email } })) ??
    (await h.tx.user.create({
      data: { id: `u_${randomUUID().slice(0, 8)}`, name: "Client", email, emailVerified: true },
    }));
  const account: AccountUser = { id: user.id, email, emailVerified: true };
  const created = await initiateReturn(
    h.tx,
    account,
    {
      orderId,
      clientKey: randomUUID(),
      items: [{ orderLineId: line.id, quantity, reasonCode: reason, reasonText: "cu text" }],
      customerNote: "Comentariul clientului",
    },
    NOW,
  );
  return { account, orderId, returnId: created.returnId, number: created.number };
}

describe("ce vede clientul", () => {
  it("returul lui, fără nota internă, fără evenimente interne și fără starea stornoului", async () => {
    await harness(async (h) => {
      const r = await setup(h, "a@exemplu.ro");
      await approveReturn(h.tx, r.returnId, ADMIN, NOW, SECRET);
      await setReturnAdminNote(h.tx, r.returnId, ADMIN, SECRET);
      const view = await getCustomerReturn(h.tx, r.account.id, r.returnId);
      const text = JSON.stringify(view);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("admin@test.ro");
      expect(text).not.toMatch(/adminNote|stornoState|stornoNote|restockedAt|resellable/);
      const types = view.events.map((e) => e.type);
      expect(types).toEqual(["return.requested", "return.approved"]);
      expect(view.status).toBe("approved");
      expect(view.canCancel).toBe(true);
      expect(view.items[0]).toMatchObject({ reasonCode: "defective", requestedQty: "1" });
    });
  });

  it("clientul B nu poate citi returul clientului A, nici îl găsește în lista lui", async () => {
    await harness(async (h) => {
      const a = await setup(h, "a@exemplu.ro");
      const b = await setup(h, "b@exemplu.ro");
      expect(await codeOf(getCustomerReturn(h.tx, b.account.id, a.returnId))).toBe(
        "RETURN_NOT_FOUND",
      );
      const list = await listCustomerReturns(h.tx, b.account.id);
      expect(list.map((x) => x.id)).toEqual([b.returnId]);
    });
  });
});

describe("ce vede adminul", () => {
  it("totul, cu emailul clientului doar când are dreptul la date personale", async () => {
    await harness(async (h) => {
      const r = await setup(h, "a@exemplu.ro");
      await setReturnAdminNote(h.tx, r.returnId, ADMIN, SECRET);
      const noPii = await getAdminReturn(h.tx, r.returnId, false);
      const withPii = await getAdminReturn(h.tx, r.returnId, true);
      expect(noPii.contactEmail).toBeNull();
      expect(JSON.stringify(noPii)).not.toContain("a@exemplu.ro");
      expect(withPii.contactEmail).toBe("a@exemplu.ro");
      expect(withPii.adminNote).toBe(SECRET);
      expect(withPii.events.map((e) => e.type)).toContain("return.note");
      expect(withPii.items[0]?.managed).toBe(true);
    });
  });

  it("lista: filtru pe stare, căutare după numărul returului și al comenzii; secțiunea din comandă", async () => {
    await harness(async (h) => {
      const a = await setup(h, "a@exemplu.ro");
      const b = await setup(h, "b@exemplu.ro");
      await approveReturn(h.tx, b.returnId, ADMIN, NOW);
      const all = await listAdminReturns(h.tx, {});
      expect(all.rows.map((x) => x.id)).toEqual(expect.arrayContaining([a.returnId, b.returnId]));
      const approved = await listAdminReturns(h.tx, { status: "approved" });
      expect(approved.rows.map((x) => x.id)).toContain(b.returnId);
      expect(approved.rows.map((x) => x.id)).not.toContain(a.returnId);
      const byNumber = await listAdminReturns(h.tx, { search: `R-${a.number}` });
      expect(byNumber.rows.map((x) => x.id)).toContain(a.returnId);
      expect(byNumber.rows.map((x) => x.id)).not.toContain(b.returnId);
      const onOrder = await listOrderReturns(h.tx, a.orderId);
      expect(onOrder.map((x) => x.id)).toEqual([a.returnId]);
    });
  });
});

describe("raportul de motive", () => {
  it("numără retururi, linii și bucăți pe motiv; anulatele nu intră implicit; perioada filtrează", async () => {
    await harness(async (h) => {
      const base = await returnReasonReport(h.tx, {});
      const get = (rows: typeof base, code: string) => rows.find((x) => x.reasonCode === code);
      const a = await setup(h, "a@exemplu.ro", "defective", "2");
      await setup(h, "b@exemplu.ro", "defective", "1");
      const c = await setup(h, "c@exemplu.ro", "changed_mind", "3");
      await h.tx.returnRequest.update({
        where: { id: c.returnId },
        data: { status: "cancelled", cancelledAt: NOW },
      });
      const rows = await returnReasonReport(h.tx, {});
      const defective = get(rows, "defective");
      expect(defective?.returns).toBe((get(base, "defective")?.returns ?? 0) + 2);
      expect(defective?.lines).toBe((get(base, "defective")?.lines ?? 0) + 2);
      expect(defective?.pieces).toBe((get(base, "defective")?.pieces ?? 0) + 3);
      expect(get(rows, "changed_mind")?.returns ?? 0).toBe(get(base, "changed_mind")?.returns ?? 0);
      const cancelled = await returnReasonReport(h.tx, { status: "cancelled" });
      expect(get(cancelled, "changed_mind")?.pieces).toBeGreaterThanOrEqual(3);
      const future = await returnReasonReport(h.tx, { from: new Date(Date.now() + 365 * DAY) });
      expect(future).toEqual([]);
      void a;
    });
  });
});
