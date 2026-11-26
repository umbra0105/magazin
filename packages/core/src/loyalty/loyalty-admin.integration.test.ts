import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, type PrismaClient } from "@ecom/db";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { estimatePurchasePoints } from "../pricing/loyalty-estimate";
import { DEFAULT_ROLES } from "../rbac/catalog";
import type { PermissionSubject } from "../rbac/can";
import { createUser } from "../test-utils/digital-fixtures";
import { enableLoyalty, putInGroup } from "../test-utils/loyalty-fixtures";
import { harness } from "../test-utils/checkout-fixtures";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { earnPoints, readBalance, redeemPoints } from "./ledger";
import { LoyaltyAdminService } from "./loyalty-admin";
import { customerLoyaltyOverview, redeemHint } from "./loyalty-read";

/**
 * Ecranele punctelor (Faza 15b), pe Postgres real (tranzacție anulată, deci și rândurile de audit dispar): permisiunile
 * verificate pe server, ajustarea cu motiv și audit fără date personale, raportul de datorie, vederea din cont și estimarea de
 * pe pagina de produs.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const NOW = new Date("2031-02-10T09:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

const subject = (roleKey: string): PermissionSubject => {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey)!;
  return {
    userId: `u_${roleKey}`,
    email: `${roleKey}@exemplu.test`,
    roles: [roleKey],
    permissions: new Set(role.permissions),
  };
};

const serviceFor = (tx: TestTx) =>
  new LoyaltyAdminService({
    db: tx as unknown as PrismaClient,
    audit: new AuditService(createPrismaAuditStore(tx as unknown as PrismaClient)),
    now: () => NOW,
  });

const run = <T>(fn: (tx: TestTx) => Promise<T>) =>
  inRolledBackTransaction(db, async (tx) => {
    await enableLoyalty(tx);
    return fn(tx);
  });

const denied = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({
    code: expect.stringMatching(/FORBIDDEN|UNAUTHENTICATED/),
  });
};

const give = (tx: TestTx, customerId: string, points: number, expiresAt: Date) =>
  earnPoints(tx, { customerId, orderId: `o_${randomUUID()}`, points, expiresAt, now: at(-1) });

describe("permisiunile punctelor", () => {
  it("rolurile: cine vede, cine ajustează", () => {
    const has = (role: string, permission: string) =>
      subject(role).permissions.has(permission as never);
    expect(
      ["loyalty.view", "loyalty.adjust", "loyalty.configure"].map((p) => has("owner", p)),
    ).toEqual([true, true, true]);
    expect(has("manager", "loyalty.view")).toBe(true);
    expect(has("manager", "loyalty.adjust")).toBe(true);
    expect(has("manager", "loyalty.configure")).toBe(false);
    expect(has("accountant", "loyalty.view")).toBe(true);
    expect(has("accountant", "loyalty.adjust")).toBe(false);
    expect(has("support", "loyalty.view")).toBe(true);
    expect(has("support", "loyalty.adjust")).toBe(false);
    for (const role of ["editor", "warehouse"]) {
      expect(has(role, "loyalty.view"), role).toBe(false);
      expect(has(role, "loyalty.adjust"), role).toBe(false);
    }
  });

  it("fără permisiune: nici citire, nici raport, nici ajustare, pe server", async () => {
    await run(async (tx) => {
      const customer = await createUser(tx);
      const service = serviceFor(tx);
      await denied(service.customer(subject("warehouse"), customer.id));
      await denied(service.debtReport(subject("editor")));
      await denied(service.search(null, ""));
      await denied(
        service.adjust(subject("accountant"), {
          customerId: customer.id,
          points: 5,
          reason: "test",
          requestKey: randomUUID(),
        }),
      );
      expect(await readBalance(tx, customer.id)).toBe(0);
    });
  });
});

describe("ajustarea manuală", () => {
  it("cere motiv; scrie registrul și auditul FĂRĂ email, nume sau textul motivului; aceeași cerere nu se aplică de două ori", async () => {
    await run(async (tx) => {
      const customer = await createUser(tx);
      const service = serviceFor(tx);
      const actor = subject("manager");
      const requestKey = randomUUID();
      const input = {
        customerId: customer.id,
        points: 25,
        reason: "Gest pentru Ion Popescu",
        requestKey,
      };
      await expect(service.adjust(actor, { ...input, reason: "  " })).rejects.toThrow();
      await expect(service.adjust(actor, { ...input, points: 0 })).rejects.toThrow();
      expect(await service.adjust(actor, input)).toEqual({ applied: true, balance: 25 });
      expect(await service.adjust(actor, input)).toEqual({ applied: false, balance: 25 });
      const rows = await tx.auditLog.findMany({
        where: { action: "loyalty.adjust", entityId: customer.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity: "loyalty_account", actorId: actor.userId });
      expect(rows[0]!.after).toEqual({ points: 25, balance: 25 });
      const dumped = JSON.stringify([rows[0]!.after, rows[0]!.before]);
      expect(dumped).not.toContain(customer.email);
      expect(dumped).not.toContain("Popescu");
      const lot = await tx.loyaltyLot.findFirstOrThrow({ where: { customerId: customer.id } });
      expect(lot.expiresAt.toISOString()).toBe("2032-02-10T09:00:00.000Z");
    });
  });

  it("un client inexistent sau anonimizat e refuzat; scăderea peste sold e refuzată", async () => {
    await run(async (tx) => {
      const service = serviceFor(tx);
      const actor = subject("owner");
      const base = { points: 5, reason: "motiv", requestKey: randomUUID() };
      await expect(service.adjust(actor, { ...base, customerId: "nu-exista" })).rejects.toThrow();
      const customer = await createUser(tx);
      await expect(
        service.adjust(actor, { ...base, customerId: customer.id, points: -1 }),
      ).rejects.toMatchObject({ code: "LOYALTY_INSUFFICIENT_POINTS" });
      await tx.user.update({ where: { id: customer.id }, data: { anonymizedAt: NOW } });
      await expect(service.adjust(actor, { ...base, customerId: customer.id })).rejects.toThrow();
    });
  });
});

describe("fișa clientului și contul", () => {
  it("sold, valoare, următorul lot care expiră și istoricul; motivul ajustării doar în admin; emailul mascat fără drept", async () => {
    await run(async (tx) => {
      const customer = await createUser(tx);
      const service = serviceFor(tx);
      await give(tx, customer.id, 10, at(100));
      await give(tx, customer.id, 4, at(20));
      await redeemPoints(tx, {
        customerId: customer.id,
        orderId: "o_necunoscuta",
        points: 1,
        now: NOW,
      });
      await service.adjust(subject("owner"), {
        customerId: customer.id,
        points: 2,
        reason: "motiv intern",
        requestKey: randomUUID(),
      });
      const overview = await customerLoyaltyOverview(tx, customer.id, NOW);
      expect(overview).toMatchObject({
        balance: 15,
        spendable: 15,
        valueMinor: 1_500,
        earns: true,
        nextExpiry: { points: 3, expiresAt: at(20) },
      });
      expect(overview.history.map((h) => [h.type, h.points, h.balanceAfter])).toEqual([
        ["adjust", 2, 15],
        ["redeem", -1, 13],
        ["earn", 4, 14],
        ["earn", 10, 10],
      ]);
      expect(JSON.stringify(overview)).not.toContain("motiv intern");

      const admin = await service.customer(subject("owner"), customer.id);
      expect(admin.history[0]!.reason).toBe("motiv intern");
      expect(admin.email).toBe(customer.email);
      const support = await service.customer(subject("accountant"), customer.id);
      expect(support.email).not.toBe(customer.email);
      expect(support.email).toContain("•••");
    });
  });

  it("un lot expirat și nescăzut nu apare ca disponibil; Partenerul vede că nu acumulează", async () => {
    await run(async (tx) => {
      const customer = await createUser(tx);
      await give(tx, customer.id, 10, at(-1));
      await putInGroup(tx, customer.id, {
        pricingType: "cost_plus",
        markupBps: 1200,
        earnsLoyaltyPoints: false,
      });
      expect(await customerLoyaltyOverview(tx, customer.id, NOW)).toMatchObject({
        balance: 10,
        spendable: 0,
        valueMinor: 0,
        earns: false,
        nextExpiry: null,
      });
    });
  });
});

describe("nota din coș", () => {
  it("doar cu sold folosibil de cel puțin minimul și cu tratamentul TVA stabilit", async () => {
    await run(async (tx) => {
      const customer = await createUser(tx);
      await give(tx, customer.id, 9, at(100));
      expect(await redeemHint(tx, customer.id, NOW)).toBeNull();
      await give(tx, customer.id, 6, at(100));
      expect(await redeemHint(tx, customer.id, NOW)).toEqual({ points: 15, valueMinor: 1_500 });
      expect(await redeemHint(tx, customer.id, at(101))).toBeNull();
      await enableLoyalty(tx, { vatMode: null });
      expect(await redeemHint(tx, customer.id, NOW)).toBeNull();
      await enableLoyalty(tx, { enabled: false });
      expect(await redeemHint(tx, customer.id, NOW)).toBeNull();
    });
  });
});

describe("raportul «datorie în puncte»", () => {
  it("disponibile pe lunile de expirare, în așteptare, valoare în lei; conturile anonimizate nu intră", async () => {
    await run(async (tx) => {
      const service = serviceFor(tx);
      const before = await service.debtReport(subject("accountant"));
      const a = await createUser(tx);
      const b = await createUser(tx);
      const gone = await createUser(tx);
      await give(tx, a.id, 10, new Date("2031-03-05T10:00:00Z"));
      await give(tx, b.id, 7, new Date("2031-03-25T10:00:00Z"));
      await give(tx, b.id, 5, new Date("2031-07-01T10:00:00Z"));
      await give(tx, gone.id, 99, at(200));
      await tx.user.update({ where: { id: gone.id }, data: { anonymizedAt: NOW } });
      const after = await service.debtReport(subject("accountant"));
      expect(after.availablePoints - before.availablePoints).toBe(22);
      expect(after.availableMinor - before.availableMinor).toBe(2_200);
      const month = (report: typeof after, key: string) =>
        report.months.find((m) => m.month === key)?.points ?? 0;
      expect(month(after, "2031-03") - month(before, "2031-03")).toBe(17);
      expect(month(after, "2031-07") - month(before, "2031-07")).toBe(5);
      expect(JSON.stringify(after)).not.toContain(a.email);
    });
  });
});

describe("«primești X puncte» pe pagina produsului", () => {
  const NOW_SALE = new Date();

  it("client: pe prețul lui; oaspete: pe prețul public; Partener: nimic; program oprit: nimic", async () => {
    await harness(async (h) => {
      await enableLoyalty(h.tx);
      const product = await h.product({ price: 100_000 });
      const ask = (userId: string | null, quantity = 10_000n) =>
        estimatePurchasePoints(
          h.tx,
          userId,
          { variantId: product.variantId, quantityTicks: quantity },
          { showSalePricing: false, taxStandardRate: 21 },
          NOW_SALE,
        );
      expect(await ask(null)).toEqual({ audience: "guest", points: 10 });
      expect(await ask(null, 30_000n)).toEqual({ audience: "guest", points: 30 });
      const user = await createUser(h.tx);
      expect(await ask(user.id)).toEqual({ audience: "member", points: 10 });
      await putInGroup(h.tx, user.id, {
        pricingType: "discount",
        discountBps: 500,
        earnsLoyaltyPoints: true,
      });
      expect(await ask(user.id)).toEqual({ audience: "member", points: 9 });
      await putInGroup(h.tx, user.id, {
        pricingType: "cost_plus",
        markupBps: 1200,
        earnsLoyaltyPoints: false,
      });
      expect(await ask(user.id)).toBeNull();
      await enableLoyalty(h.tx, { enabled: false });
      expect(await ask(null)).toBeNull();
    });
  });

  it("sub un punct nu se arată nimic; produs la promoție exclus din setări: nimic", async () => {
    await harness(async (h) => {
      await enableLoyalty(h.tx, { earnOnDiscountedItems: false });
      const cheap = await h.product({ price: 9_999 });
      const promo = await h.product({ price: 100_000 });
      await h.tx.productVariant.update({
        where: { id: promo.variantId },
        data: {
          salePrice: 90_000,
          saleStartsAt: new Date(NOW_SALE.getTime() - DAY),
          saleEndsAt: new Date(NOW_SALE.getTime() + DAY),
        },
      });
      const ask = (variantId: string) =>
        estimatePurchasePoints(
          h.tx,
          null,
          { variantId, quantityTicks: 10_000n },
          { showSalePricing: true, taxStandardRate: 21 },
          NOW_SALE,
        );
      expect(await ask(cheap.variantId)).toBeNull();
      expect(await ask(promo.variantId)).toBeNull();
    });
  });
});
