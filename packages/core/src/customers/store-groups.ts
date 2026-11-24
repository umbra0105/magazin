import type { SeedDb } from "../seed/base-seed";
import type { GroupTone, PricingType } from "./constants";

/**
 * Grupurile SPECIFICE MAGAZINULUI acesta (Faza 15, decizia utilizatorului, 2026-11-24): NU sunt default de pachet, ci un seed rulat
 * de proprietar (`db:seed:store`). Procentele sunt întregi în puncte de bază și se editează din admin; seed-ul nu le
 * suprascrie niciodată (creează doar grupurile lipsă, după slug).
 *
 * Standard, Fidel și VIP acumulează puncte de loialitate; Partenerii NU (`earnsLoyaltyPoints = false`).
 */
export interface StoreGroupSeed {
  slug: string;
  name: string;
  pricingType: PricingType;
  discountBps: number | null;
  markupBps: number | null;
  earnsLoyaltyPoints: boolean;
  tone: GroupTone;
  sortOrder: number;
}

export const STORE_GROUPS: readonly StoreGroupSeed[] = [
  {
    slug: "client-fidel",
    name: "Client fidel",
    pricingType: "discount",
    discountBps: 500,
    markupBps: null,
    earnsLoyaltyPoints: true,
    tone: "success",
    sortOrder: 10,
  },
  {
    slug: "client-vip",
    name: "Client VIP",
    pricingType: "discount",
    discountBps: 700,
    markupBps: null,
    earnsLoyaltyPoints: true,
    tone: "info",
    sortOrder: 20,
  },
  {
    slug: "partener-1",
    name: "Partener 1",
    pricingType: "cost_plus",
    discountBps: null,
    markupBps: 1200,
    earnsLoyaltyPoints: false,
    tone: "warning",
    sortOrder: 30,
  },
  {
    slug: "partener-2",
    name: "Partener 2",
    pricingType: "cost_plus",
    discountBps: null,
    markupBps: 1700,
    earnsLoyaltyPoints: false,
    tone: "warning",
    sortOrder: 40,
  },
  {
    slug: "partener-3",
    name: "Partener 3",
    pricingType: "cost_plus",
    discountBps: null,
    markupBps: 2100,
    earnsLoyaltyPoints: false,
    tone: "warning",
    sortOrder: 50,
  },
];

/** Creează grupurile magazinului care lipsesc (după slug); idempotent, nedistructiv. Întoarce câte s-au creat. */
export async function seedStoreGroups(db: SeedDb): Promise<number> {
  const result = await db.customerGroup.createMany({
    data: STORE_GROUPS.map((group) => ({ ...group })),
    skipDuplicates: true,
  });
  return result.count;
}
