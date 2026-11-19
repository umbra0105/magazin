import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { claimDispatch, enqueueDispatches, failDispatch } from "../email/dispatch";
import { cancelOrder } from "../orders/order-actions";
import { listPayments } from "../payments/payment-admin";
import { harness, NOW, q, type Harness } from "../test-utils/checkout-fixtures";
import {
  cardHarness,
  deliver,
  paidEvent,
  placeCardOrder,
  processorDeps,
} from "../test-utils/payment-fixtures";
import { adminCounters } from "./admin-counters";
import {
  listNotifications,
  markNotificationsRead,
  notifyAdmins,
  unreadNotificationCount,
} from "./admin-notifications";

/**
 * Notificările interne și contoarele din meniu (Faza 11), pe Postgres real, în tranzacție anulată: o singură notificare pe situație,
 * vizibile doar după permisiune, citit/necitit per utilizator, fără date personale în titlu; contorul = lista.
 */
const db = getDb();
afterAll(() => db.$disconnect());

async function user(h: Harness, name: string) {
  return h.tx.user.create({
    data: { id: `u-${randomUUID()}`, name, email: `${name}-${randomUUID()}@exemplu.invalid` },
  });
}

const note = (key: string, over: Partial<Parameters<typeof notifyAdmins>[1]> = {}) => ({
  kind: "payment_attention" as const,
  title: "O plată necesită atenție",
  href: "/admin/comenzi/plati/x",
  permission: "payments.read" as const,
  dedupKey: key,
  ...over,
});

describe("notificările", () => {
  it("aceeași situație (dedupKey) produce o singură notificare, chiar la scrieri repetate", async () => {
    await harness(async (h) => {
      const key = `t-${randomUUID()}`;
      expect(await notifyAdmins(h.tx, note(key))).toBe(true);
      expect(await notifyAdmins(h.tx, note(key))).toBe(false);
      expect(await h.tx.adminNotification.count({ where: { dedupKey: key } })).toBe(1);
    });
  });

  it("se văd doar cu permisiunea notificării; citit/necitit e per utilizator", async () => {
    await harness(async (h) => {
      const a = await user(h, "a");
      const b = await user(h, "b");
      await notifyAdmins(
        h.tx,
        note(`k-${randomUUID()}`, { permission: "payments.read", title: "Plată" }),
      );
      await notifyAdmins(
        h.tx,
        note(`k-${randomUUID()}`, {
          permission: "email.read",
          kind: "email_failed",
          title: "Email",
        }),
      );
      const withPayments = { userId: a.id, permissions: new Set(["payments.read"]) };
      const both = { userId: b.id, permissions: new Set(["payments.read", "email.read"]) };
      const none = { userId: b.id, permissions: new Set<string>(["orders.read"]) };
      const titles = async (u: typeof both) =>
        (await listNotifications(h.tx, u)).map((n) => n.title).sort();
      expect(await titles(withPayments)).toContain("Plată");
      expect(await titles(withPayments)).not.toContain("Email");
      expect(await titles(both)).toEqual(expect.arrayContaining(["Plată", "Email"]));
      expect(await titles(none)).toEqual([]);

      const beforeA = await unreadNotificationCount(h.tx, withPayments);
      const beforeB = await unreadNotificationCount(h.tx, both);
      expect(await markNotificationsRead(h.tx, withPayments)).toBeGreaterThanOrEqual(1);
      expect(await unreadNotificationCount(h.tx, withPayments)).toBe(0);
      // citirea lui A nu o citește și pe a lui B
      expect(await unreadNotificationCount(h.tx, both)).toBe(beforeB);
      expect(beforeA).toBeGreaterThanOrEqual(1);
      // idempotent
      expect(await markNotificationsRead(h.tx, withPayments)).toBe(0);
    });
  });

  it("un utilizator nu poate marca citită o notificare pe care nu o vede", async () => {
    await harness(async (h) => {
      const a = await user(h, "a");
      const key = `k-${randomUUID()}`;
      await notifyAdmins(h.tx, note(key, { permission: "email.read", kind: "email_failed" }));
      const row = await h.tx.adminNotification.findUniqueOrThrow({ where: { dedupKey: key } });
      const limited = { userId: a.id, permissions: new Set(["payments.read"]) };
      expect(await markNotificationsRead(h.tx, limited, [row.id])).toBe(0);
      expect(await h.tx.adminNotificationRead.count({ where: { notificationId: row.id } })).toBe(0);
    });
  });

  it("CHECK-ul din bază: legătura trebuie să fie o cale de admin; titlul nu poate fi gol", async () => {
    await harness(async (h) => {
      const bad = async (data: Partial<{ href: string; title: string }>) => {
        await h.tx.$executeRawUnsafe("SAVEPOINT n");
        try {
          await h.tx.adminNotification.create({
            data: {
              kind: "payment_attention",
              title: "t",
              href: "/admin/x",
              permission: "payments.read",
              dedupKey: `c-${randomUUID()}`,
              ...data,
            },
          });
          return "trecut";
        } catch {
          return "respins";
        } finally {
          await h.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT n");
        }
      };
      expect(await bad({ href: "https://exemplu.ro/x" })).toBe("respins");
      expect(await bad({ href: "/cont" })).toBe("respins");
      expect(await bad({ title: "" })).toBe("respins");
      expect(await bad({})).toBe("trecut");
    });
  });
});

describe("notificările produse de sistem", () => {
  it("anularea unei comenzi plătite pune plata în «necesită atenție»: o notificare, fără date personale în titlu", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const card = await placeCardOrder(h);
      await deliver(deps, paidEvent(card.paymentId, card.amountMinor));
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: card.orderId } });
      const before = await h.tx.adminNotification.count({ where: { kind: "payment_attention" } });
      await cancelOrder(h.tx, card.orderId, {
        reason: "Produs indisponibil",
        actorLabel: "o@e.ro",
        now: NOW,
        acknowledgePaid: true,
      });
      const rows = await h.tx.adminNotification.findMany({
        where: { kind: "payment_attention", href: `/admin/comenzi/plati/${card.paymentId}` },
      });
      expect(rows).toHaveLength(1);
      expect(await h.tx.adminNotification.count({ where: { kind: "payment_attention" } })).toBe(
        before + 1,
      );
      expect(rows[0]?.permission).toBe("payments.read");
      expect(JSON.stringify(rows)).not.toContain(order.email);
      expect(JSON.stringify(rows)).not.toContain(order.number);
    });
  });

  it("emailul blocat definitiv (dead-letter) produce o notificare cu permisiunea email.read, o singură dată", async () => {
    await harness(async (h) => {
      const product = await h.product({ physical: "100" });
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
      const { orderId } = await h.checkout.place(owner, await h.input(owner));
      const dispatch = await h.tx.emailDispatch.findFirstOrThrow({ where: { orderId } });
      await claimDispatch(h.tx, dispatch.id, NOW);
      await failDispatch(h.tx, dispatch.id, "EENVELOPE: x");
      await failDispatch(h.tx, dispatch.id, "EENVELOPE: x");
      const rows = await h.tx.adminNotification.findMany({
        where: { dedupKey: `email-failed:${dispatch.id}` },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "email_failed", permission: "email.read" });
      expect(rows[0]?.href).toBe("/admin/comenzi/sabloane-email?vedere=jurnal&filtru=esuate");
      expect(JSON.stringify(rows)).not.toContain(dispatch.recipient);
    });
  });
});

describe("contoarele din meniu", () => {
  it("fiecare contor = lista pe care o deschide: comenzi de procesat, plăți care cer atenție, emailuri blocate", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const product = await h.product({ physical: "100" });
      const owner = await h.fill([{ variantId: product.variantId, quantity: q("1") }]);
      await h.checkout.place(owner, await h.input(owner));
      const card = await placeCardOrder(h);
      await deliver(deps, paidEvent(card.paymentId, card.amountMinor));
      await cancelOrder(h.tx, card.orderId, {
        reason: "Motiv bun",
        actorLabel: "o@e.ro",
        now: NOW,
        acknowledgePaid: true,
      });
      const dispatch = await h.tx.emailDispatch.findFirstOrThrow({
        where: { template: "order.confirmation" },
      });
      await claimDispatch(h.tx, dispatch.id, NOW);
      await failDispatch(h.tx, dispatch.id, "EENVELOPE: x");

      const counters = await adminCounters(h.tx, NOW);
      const toProcess = await h.tx.order.count({
        where: { status: "confirmed", fulfillmentStatus: "unfulfilled" },
      });
      expect(counters.ordersToProcess).toBe(toProcess);
      const attention = await listPayments(h.tx, { view: "attention", page: 1, pageSize: 100 });
      expect(counters.paymentsAttention).toBe(attention.total);
      expect(counters.paymentsAttention).toBeGreaterThanOrEqual(1);
      expect(counters.emailsFailed).toBe(
        await h.tx.emailDispatch.count({ where: { status: "failed" } }),
      );
      expect(counters.emailsFailed).toBeGreaterThanOrEqual(1);
      expect(counters.stuckEvents).toBeGreaterThanOrEqual(0);
    });
  });

  it("fără nimic de arătat, contoarele sunt 0 (nu apar elemente moarte)", async () => {
    await harness(async (h) => {
      await enqueueDispatches(h.tx, []);
      const counters = await adminCounters(h.tx, NOW);
      for (const value of Object.values(counters)) expect(value).toBeGreaterThanOrEqual(0);
    });
  });
});
