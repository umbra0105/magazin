import type { Prisma, PrismaClient } from "@ecom/db";
import { toPriceGroup, type CustomerGroupRecord } from "../customers/group-rules";
import type { PricingType } from "../customers/constants";
import type { PriceGroup, PricingLineInput } from "./engine";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Grupul de clienți al cumpărătorului, așa cum îl folosește prețul (Faza 15). SINGURUL loc din coș care află grupul și, la
 * `cost_plus`, prețul de achiziție al variantelor din coș; coșul și checkout-ul primesc doar prețuri și etichete (docs/09 §1).
 *
 * ⚠️ Costul iese de aici doar ca parametru al motorului de prețuri. Nu se pune în rezultatele coșului, în instantaneul comenzii sau
 * în loguri; testul de arhitectură al costului păzește asta (acest director e singurul din coș care are voie să-l numească).
 *
 * Oaspetele și clientul fără grup (sau în «Client standard») primesc `none`: exact prețul public de dinainte de Faza 15.
 */
export interface CustomerPricing {
  /** Grupul în forma motorului de prețuri. */
  group: PriceGroup;
  /** Grupul clientului (pentru snapshot și etichete); `null` = fără grup atribuit. */
  record: Pick<
    CustomerGroupRecord,
    | "id"
    | "name"
    | "pricingType"
    | "discountBps"
    | "markupBps"
    | "stacksWithSalePrice"
    | "earnsLoyaltyPoints"
  > | null;
}

export const NO_GROUP_PRICING: CustomerPricing = {
  group: { pricingType: "none" },
  record: null,
};

/** Grupul cumpărătorului logat; fără cont sau fără grup, prețul public. */
export async function loadCustomerPricing(db: Db, userId: string | null): Promise<CustomerPricing> {
  if (userId === null) return NO_GROUP_PRICING;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      customerGroup: {
        select: {
          id: true,
          name: true,
          pricingType: true,
          discountBps: true,
          markupBps: true,
          stacksWithSalePrice: true,
          earnsLoyaltyPoints: true,
        },
      },
    },
  });
  const row = user?.customerGroup ?? null;
  if (row === null) return NO_GROUP_PRICING;
  const record = { ...row, pricingType: row.pricingType as PricingType };
  return { group: toPriceGroup(record), record };
}

/** Prețurile de achiziție NET ale variantelor din coș, doar pentru un grup `cost_plus`; altfel goale (nu se citește nimic). */
export type PartnerInputs = ReadonlyMap<string, number>;

export const NO_PARTNER_INPUTS: PartnerInputs = new Map();

export async function loadPartnerInputs(
  db: Db,
  pricing: CustomerPricing,
  variantIds: readonly string[],
): Promise<PartnerInputs> {
  if (pricing.group.pricingType !== "cost_plus" || variantIds.length === 0)
    return NO_PARTNER_INPUTS;
  const rows = await db.productVariant.findMany({
    where: { id: { in: [...new Set(variantIds)] } },
    select: { id: true, costPrice: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.costPrice !== null && row.costPrice > 0 ? [[row.id, row.costPrice] as const] : [],
    ),
  );
}

/** Adaugă la intrarea motorului prețul de intrare al variantei (dacă există); fără el, `cost_plus` cade pe prețul public. */
export function withPartnerInput(input: PricingLineInput, inputs: PartnerInputs): PricingLineInput {
  const value = inputs.get(input.key);
  return value === undefined ? input : { ...input, costNetMinor: value };
}
