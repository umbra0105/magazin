import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { claimDispatch, enqueueDispatches, failDispatch } from "../email/dispatch";
import { ATTENTION_REASONS } from "../payments/payment-errors";
import { ATTENTION_REASON_LABELS } from "../payments/attention-labels";
import { requestRefund } from "../payments/refund-service";
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

describe("contextul notificării", () => {
  it("se salvează și se citește; notificările vechi (fără context) rămân valide", async () => {
    await harness(async (h) => {
      const a = await user(h, "a");
      await notifyAdmins(
        h.tx,
        note(`ctx-${randomUUID()}`, {
          title: "Cu context",
          context: "Comanda WEB-000123 · Plată dublă",
        }),
      );
      await notifyAdmins(h.tx, note(`ctx-${randomUUID()}`, { title: "Fără context" }));
      const list = await listNotifications(h.tx, {
        userId: a.id,
        permissions: new Set(["payments.read"]),
      });
      expect(list.find((n) => n.title === "Cu context")?.context).toBe(
        "Comanda WEB-000123 · Plată dublă",
      );
      expect(list.find((n) => n.title === "Fără context")?.context).toBeNull();
    });
  });

  it("CHECK-ul din bază: contextul e NULL sau are 1–200 de caractere (gol sau prea lung = respins)", async () => {
    await harness(async (h) => {
      const attempt = async (context: string | null) => {
        await h.tx.$executeRawUnsafe("SAVEPOINT c");
        try {
          await h.tx.adminNotification.create({
            data: {
              kind: "payment_attention",
              title: "t",
              href: "/admin/x",
              permission: "payments.read",
              dedupKey: `cc-${randomUUID()}`,
              context,
            },
          });
          return "trecut";
        } catch {
          return "respins";
        } finally {
          await h.tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT c");
        }
      };
      expect(await attempt(null)).toBe("trecut");
      expect(await attempt("x")).toBe("trecut");
      expect(await attempt("x".repeat(200))).toBe("trecut");
      expect(await attempt("")).toBe("respins");
      expect(await attempt("x".repeat(201))).toBe("respins");
    });
  });

  it("fiecare motiv «necesită atenție» are o etichetă (nicio notificare cu motivul brut)", () => {
    expect(Object.keys(ATTENTION_REASON_LABELS).sort()).toEqual([...ATTENTION_REASONS].sort());
    for (const label of Object.values(ATTENTION_REASON_LABELS)) {
      expect(label.length).toBeGreaterThan(3);
      expect(label).not.toMatch(/_/);
    }
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
      expect(rows[0]).toMatchObject({
        title: "O plată necesită atenție",
        permission: "payments.read",
        context: `Comanda ${order.number} · ${ATTENTION_REASON_LABELS.order_cancelled_paid}`,
      });
      // numărul comenzii e context, nu dată personală; emailul, telefonul și numele clientului nu apar nicăieri
      const text = JSON.stringify(rows.map((row) => [row.title, row.context, row.href]));
      const addresses = await h.tx.address.findMany({ where: { orderId: card.orderId } });
      expect(addresses.length).toBeGreaterThan(0);
      for (const secret of [
        order.email,
        order.phone,
        ...addresses.flatMap((a) => [a.fullName, a.street, a.phone]),
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  it("emailul blocat definitiv (dead-letter) al unei comenzi: o singură notificare, cu legătură către COMANDA și numărul ei în context", async () => {
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
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(rows[0]).toMatchObject({
        kind: "email_failed",
        permission: "orders.read",
        title: "Un email a rămas netrimis",
        href: `/admin/comenzi/${orderId}`,
      });
      expect(rows[0]?.context).toBe(`Comanda ${order.number} · Confirmare comandă`);
      expect(JSON.stringify(rows)).not.toContain(dispatch.recipient);
      expect(JSON.stringify(rows)).not.toContain(order.phone);
    });
  });

  it("emailul intern blocat (fără comandă): legătura rămâne jurnalul de emailuri, cu permisiunea email.read", async () => {
    await harness(async (h) => {
      const dispatch = await h.tx.emailDispatch.create({
        data: {
          template: "internal.stock_out",
          eventKey: `t-${randomUUID()}`,
          recipient: "admin@exemplu.invalid",
          audience: "internal",
          status: "sending",
        },
      });
      await failDispatch(h.tx, dispatch.id, "EENVELOPE: x");
      const row = await h.tx.adminNotification.findUniqueOrThrow({
        where: { dedupKey: `email-failed:${dispatch.id}` },
      });
      expect(row).toMatchObject({
        permission: "email.read",
        href: "/admin/comenzi/sabloane-email?vedere=jurnal&filtru=esuate",
        context: "Notificare internă: stoc epuizat",
      });
      expect(JSON.stringify(row)).not.toContain(dispatch.recipient);
    });
  });

  it("rambursarea manuală: legătură către plată, numărul comenzii în context, permisiunea de rambursare", async () => {
    await cardHarness(async (h) => {
      const deps = processorDeps(h);
      const card = await placeCardOrder(h);
      await deliver(deps, paidEvent(card.paymentId, card.amountMinor));
      const order = await h.tx.order.findUniqueOrThrow({ where: { id: card.orderId } });
      const provider = {
        ...deps.provider,
        refund: async () => ({ status: "manual_required" as const, message: "manual" }),
      };
      await requestRefund(
        { db: h.tx, getProvider: async () => provider, now: () => NOW },
        {
          paymentId: card.paymentId,
          amountMinor: card.amountMinor,
          reason: "Produs returnat",
          idempotencyKey: "n1",
          actorLabel: "admin@exemplu.ro",
        },
      );
      const row = await h.tx.adminNotification.findFirstOrThrow({
        where: { kind: "refund_manual", href: `/admin/comenzi/plati/${card.paymentId}` },
      });
      expect(row).toMatchObject({
        title: "O rambursare trebuie făcută manual",
        permission: "payments.refund",
        context: `Comanda ${order.number} · Rambursare manuală necesară`,
      });
      expect(JSON.stringify(row)).not.toContain(order.email);
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
