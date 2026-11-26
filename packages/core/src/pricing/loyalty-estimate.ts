import type { Prisma, PrismaClient } from "@ecom/db";
import { QUANTITY_FACTOR, percentToBasisPoints, quantityFromTicks } from "@ecom/shared";
import type { PriceBasis } from "../inventory/constants";
import { readLoyaltySettings } from "../loyalty/loyalty-settings";
import { loadCustomerPricing } from "./customer-pricing";
import {
  activeSalePrice,
  excludedFromGroupPricing,
  priceLines,
  type PricingLineInput,
} from "./engine";
import { earnedPoints } from "./points";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * «Primești X puncte la această achiziție» de pe pagina produsului (Faza 15b): calculat DINAMIC, pe cerere, prin motorul de
 * prețuri, pentru cumpărătorul curent și cantitatea aleasă. Pagina din cache (ISR) nu conține nimic din el.
 *  - oaspetele primește estimarea pe prețul PUBLIC (niciodată vreo valoare de grup), cu textul «Creează cont…»;
 *  - clientul autentificat, pe prețul lui; grupul care nu acumulează (parteneri) nu primește nimic și nu se citește niciun cost;
 *  - cu programul oprit sau sub un punct: nimic.
 */
export interface PurchasePointsEstimate {
  audience: "guest" | "member";
  points: number;
}

export interface EstimateSettings {
  showSalePricing: boolean;
  /** `tax.standardRate`, în procente. */
  taxStandardRate: number;
}

const MAX_ESTIMATE_LINE_MINOR = 1_000_000_000;

export async function estimatePurchasePoints(
  db: Db,
  userId: string | null,
  request: { variantId: string; quantityTicks: bigint },
  settings: EstimateSettings,
  at: Date,
): Promise<PurchasePointsEstimate | null> {
  const loyalty = await readLoyaltySettings(db);
  if (!loyalty.active) return null;
  const pricing = await loadCustomerPricing(db, userId);
  if (pricing.record && !pricing.record.earnsLoyaltyPoints) return null;
  if (request.quantityTicks <= 0n) return null;
  const row = await db.productVariant.findFirst({
    where: { id: request.variantId, product: { status: "active", deletedAt: null } },
    select: {
      id: true,
      productId: true,
      price: true,
      salePrice: true,
      saleStartsAt: true,
      saleEndsAt: true,
      priceBasis: true,
      product: {
        select: {
          priceBasis: true,
          excludeFromGroupDiscount: true,
          categories: {
            select: { categoryId: true, category: { select: { excludeFromGroupDiscount: true } } },
          },
        },
      },
    },
  });
  if (!row) return null;
  const quantity = quantityFromTicks(request.quantityTicks);
  const basis = (row.priceBasis ?? row.product.priceBasis) as PriceBasis;
  const input: PricingLineInput = {
    key: row.id,
    productId: row.productId,
    categoryIds: row.product.categories.map((entry) => entry.categoryId),
    basis,
    priceMinor: row.price,
    salePriceMinor: activeSalePrice(row, at),
    quantity,
    // la prețul pe pas, pasul e chiar cantitatea unui pas ales în pagină
    step: basis === "step" ? quantity : quantityFromTicks(QUANTITY_FACTOR),
    taxRateBps: percentToBasisPoints(settings.taxStandardRate),
    excludeFromGroupDiscount: excludedFromGroupPricing(
      row.product.excludeFromGroupDiscount,
      row.product.categories.map((entry) => entry.category.excludeFromGroupDiscount),
    ),
  };
  // grupurile care acumulează nu au nevoie de preț de achiziție (partenerii s-au oprit mai sus)
  const group =
    pricing.group.pricingType === "cost_plus" ? { pricingType: "none" as const } : pricing.group;
  let line;
  try {
    line = priceLines([input], {
      applySale: settings.showSalePricing,
      group,
      now: at,
      maxLineMinor: MAX_ESTIMATE_LINE_MINOR,
    }).lines[0];
  } catch {
    return null;
  }
  if (!line || (!loyalty.earnOnDiscountedItems && line.onSale === true)) return null;
  const points = earnedPoints(line.totalMinor, loyalty.earnRate);
  return points > 0 ? { audience: userId === null ? "guest" : "member", points } : null;
}
