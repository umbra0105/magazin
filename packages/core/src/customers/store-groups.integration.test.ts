import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction } from "../test-utils/rollback";
import { STORE_GROUPS, seedStoreGroups } from "./store-groups";

const db = getDb();
afterAll(() => db.$disconnect());

describe("grupurile magazinului (seed specific, nu default de pachet)", () => {
  it("valorile decise de utilizator, la 2026-11-24", () => {
    const byName = Object.fromEntries(STORE_GROUPS.map((g) => [g.name, g]));
    expect(byName["Client fidel"]).toMatchObject({ pricingType: "discount", discountBps: 500 });
    expect(byName["Client VIP"]).toMatchObject({ pricingType: "discount", discountBps: 700 });
    expect(byName["Partener 1"]).toMatchObject({ pricingType: "cost_plus", markupBps: 1200 });
    expect(byName["Partener 2"]).toMatchObject({ pricingType: "cost_plus", markupBps: 1700 });
    expect(byName["Partener 3"]).toMatchObject({ pricingType: "cost_plus", markupBps: 2100 });
    // Partenerii NU acumulează puncte; Fidel și VIP da
    for (const g of STORE_GROUPS) {
      expect(g.earnsLoyaltyPoints, g.name).toBe(g.pricingType !== "cost_plus");
    }
    expect(STORE_GROUPS).toHaveLength(5);
  });

  it("creează grupurile lipsă, de două ori nu schimbă nimic și nu suprascrie editările din admin", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await runBaseSeed(tx);
      const before = await tx.customerGroup.count();
      const first = await seedStoreGroups(tx);
      // o bază care are deja unele grupuri (seed rulat anterior) primește doar ce lipsește
      expect(first).toBeLessThanOrEqual(5);
      expect(await tx.customerGroup.count()).toBe(before + first);
      const rows = await tx.customerGroup.findMany({
        where: { slug: { in: STORE_GROUPS.map((g) => g.slug) } },
      });
      expect(rows).toHaveLength(5);
      for (const seed of STORE_GROUPS) {
        expect(rows.find((r) => r.slug === seed.slug)).toMatchObject({
          pricingType: seed.pricingType,
          discountBps: seed.discountBps,
          markupBps: seed.markupBps,
          earnsLoyaltyPoints: seed.earnsLoyaltyPoints,
          isSystem: false,
          stacksWithSalePrice: false,
        });
      }
      await tx.customerGroup.update({
        where: { slug: "partener-1" },
        data: { markupBps: 1500 },
      });
      expect(await seedStoreGroups(tx)).toBe(0);
      expect(
        (await tx.customerGroup.findUniqueOrThrow({ where: { slug: "partener-1" } })).markupBps,
      ).toBe(1500);
    });
  });
});
