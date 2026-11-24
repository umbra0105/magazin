import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DEFAULT_ROLES } from "../rbac/catalog";
import type { PermissionSubject } from "../rbac/can";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { salesByGroup } from "./group-report";

/** Raportul vânzărilor per grup: cifre calculate de mână, în tranzacție anulată; fără cost; doar cu `reports.read`. */
const db = getDb();
afterAll(() => db.$disconnect());

const uid = (): string => randomUUID().slice(0, 8);
const NOW = new Date("2030-06-15T12:00:00.000Z");
const DAY = 86_400_000;

const subjectFor = (role: string): PermissionSubject => ({
  userId: `u_${uid()}`,
  email: `${role}@exemplu.test`,
  roles: [role],
  permissions: new Set(DEFAULT_ROLES.find((r) => r.key === role)?.permissions ?? []),
});

async function order(tx: TestTx, channelId: string, over: Record<string, unknown>) {
  const total = typeof over["totalMinor"] === "number" ? over["totalMinor"] : 10_000;
  return tx.order.create({
    data: {
      number: `T-${uid()}`,
      channelId,
      email: `c-${uid()}@exemplu.test`,
      phone: "0722000000",
      subtotalMinor: total,
      shippingMinor: 0,
      taxMinor: 1_735,
      totalMinor: total,
      taxRateBps: 2100,
      shippingMethodCode: "courier",
      shippingSnapshot: {},
      paymentMethod: "cod",
      termsAcceptedAt: NOW,
      termsConsentText: "ok",
      termsConsentVersion: "t",
      idempotencyKey: randomUUID(),
      placedAt: new Date(NOW.getTime() - DAY),
      ...over,
    } as never,
  });
}

describe("vânzări per grup și avantaj acordat", () => {
  it("însumează pe grup, numără doar comenzile din perioadă și neanulate, și are un rând pentru comenzile fără grup", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const channel = await tx.salesChannel.create({ data: { code: `t_${uid()}`, name: "Canal" } });
      const fidel = await tx.customerGroup.create({
        data: {
          name: `Fidel ${uid()}`,
          slug: `f-${uid()}`,
          pricingType: "discount",
          discountBps: 500,
        },
      });
      const partner = await tx.customerGroup.create({
        data: {
          name: `Partener ${uid()}`,
          slug: `p-${uid()}`,
          pricingType: "cost_plus",
          markupBps: 1200,
        },
      });
      const snap = (group: { id: string }, type: string, advantage: number, total: number) => ({
        customerGroupId: group.id,
        groupPricingType: type,
        ...(type === "discount" ? { groupDiscountBps: 500 } : { groupMarkupBps: 1200 }),
        groupAdvantageMinor: advantage,
        totalMinor: total,
      });
      await order(tx, channel.id, snap(fidel, "discount", 995, 18_905));
      await order(tx, channel.id, snap(fidel, "discount", 1_005, 19_000));
      await order(tx, channel.id, snap(partner, "cost_plus", 6_348, 13_552));
      await order(tx, channel.id, { totalMinor: 20_000 }); // fără grup
      // în afara perioadei și anulată: nu se numără
      await order(tx, channel.id, {
        ...snap(fidel, "discount", 50, 10_000),
        placedAt: new Date(NOW.getTime() - 40 * DAY),
      });
      await order(tx, channel.id, {
        ...snap(fidel, "discount", 70, 10_000),
        status: "cancelled",
        cancelledAt: NOW,
      });

      const report = await salesByGroup(tx, subjectFor("accountant"), {
        from: new Date(NOW.getTime() - 30 * DAY),
        to: NOW,
      });
      const byId = new Map(report.rows.map((row) => [row.groupId, row]));
      expect(byId.get(fidel.id)).toMatchObject({
        orders: 2,
        totalMinor: 37_905,
        advantageMinor: 2_000,
      });
      expect(byId.get(partner.id)).toMatchObject({
        orders: 1,
        totalMinor: 13_552,
        advantageMinor: 6_348,
      });
      expect(byId.get(null)).toMatchObject({
        orders: 1,
        totalMinor: 20_000,
        advantageMinor: 0,
        groupName: null,
      });
      expect(report.totals.advantageMinor).toBeGreaterThanOrEqual(8_348);
      // sortat după valoare, descrescător
      const totals = report.rows.map((row) => row.totalMinor);
      expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    });
  });

  it("nu conține nicio proprietate de cost sau de adaos (nici în rânduri, nici în totaluri)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const report = await salesByGroup(tx, subjectFor("manager"), {
        from: new Date(NOW.getTime() - 30 * DAY),
        to: NOW,
      });
      const keys: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
          for (const [key, inner] of Object.entries(value)) {
            keys.push(key);
            walk(inner);
          }
        }
      };
      walk(report);
      expect(keys.filter((key) => /cost|markup|adaos|profit/i.test(key))).toEqual([]);
    });
  });

  it("cere reports.read: Suportul, Depozitul și Editorul sunt refuzați", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      for (const role of ["support", "warehouse", "editor"]) {
        await expect(
          salesByGroup(tx, subjectFor(role), { from: new Date(0), to: NOW }),
        ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      }
      await expect(salesByGroup(tx, null, { from: new Date(0), to: NOW })).rejects.toMatchObject({
        code: "AUTH_UNAUTHENTICATED",
      });
    });
  });
});
