import type { Prisma, PrismaClient } from "@ecom/db";
import { QUANTITY_FACTOR, percentToBasisPoints, quantityFromTicks } from "@ecom/shared";
import { toPublicGroupView, type PublicGroupView } from "../customers/group-rules";
import { loadCustomerPricing, loadPartnerInputs, withPartnerInput } from "./customer-pricing";
import {
  activeSalePrice,
  excludedFromGroupPricing,
  resolveUnitPrice,
  type PricingLineInput,
} from "./engine";
import type { PriceBasis } from "../inventory/constants";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Prețul de GRUP afișat în vitrină (Faza 15, docs/09 §5): pentru un client logat cu grup cu preț special, prețul lui pe variantă și
 * pe card, față de prețul standard (public, cu promoția activă). Calculat DINAMIC, pe cerere, DOAR prin motorul de prețuri
 * (`resolveUnitPrice`): paginile publice (ISR) rămân cu prețul public și nu conțin niciodată prețul unui grup.
 *
 * Rezultatul conține doar sume în bani și eticheta grupului (fără adaos și fără cost). Oaspetele, clientul fără grup și «Client
 * standard» primesc un rezultat gol: vitrina lor rămâne exact cea de azi. Un preț de grup apare doar când e MAI MIC decât prețul
 * standard (altfel se afișează simplu, ca la oricine).
 */

export interface GroupPrice {
  /** Prețul clientului (per bază: unitate sau pas, ca prețul public). */
  amount: number;
  /** Prețul standard (public curent), afișat tăiat. */
  standard: number;
}

export interface GroupListingPrice extends GroupPrice {
  /** Variantele au prețuri diferite: cardul arată «de la». */
  isRange: boolean;
}

export interface GroupDisplayResult {
  /** `null` pentru oaspete, client fără grup sau grup fără preț special. */
  group: PublicGroupView | null;
  variants: Record<string, GroupPrice>;
  products: Record<string, GroupListingPrice>;
}

export const EMPTY_GROUP_DISPLAY: GroupDisplayResult = { group: null, variants: {}, products: {} };

export interface GroupDisplaySettings {
  /** `catalog.showSalePricing`. */
  showSalePricing: boolean;
  /** `tax.standardRate`, în procente. */
  taxStandardRate: number;
}

/** Cel mult atâtea variante sau produse într-o cerere (protecție la cereri uriașe). */
export const GROUP_DISPLAY_MAX_IDS = 120;

const ONE = quantityFromTicks(QUANTITY_FACTOR);

const VARIANT_SELECT = {
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
} satisfies Prisma.ProductVariantSelect;

type Row = Prisma.ProductVariantGetPayload<{ select: typeof VARIANT_SELECT }>;

/**
 * Prețurile de grup pentru variantele date (`variantIds`) și, pentru carduri, pentru toate variantele produselor date
 * (`productIds`). Fără client logat sau fără grup cu preț special: rezultat gol, fără nicio citire a costului.
 */
export async function loadGroupDisplayPrices(
  db: Db,
  userId: string | null,
  request: { variantIds: readonly string[]; productIds: readonly string[] },
  settings: GroupDisplaySettings,
  at: Date,
): Promise<GroupDisplayResult> {
  const pricing = await loadCustomerPricing(db, userId);
  if (pricing.record === null || pricing.record.pricingType === "none") return EMPTY_GROUP_DISPLAY;

  const variantIds = [...new Set(request.variantIds)].slice(0, GROUP_DISPLAY_MAX_IDS);
  const productIds = [...new Set(request.productIds)].slice(0, GROUP_DISPLAY_MAX_IDS);
  if (variantIds.length === 0 && productIds.length === 0) {
    return { ...EMPTY_GROUP_DISPLAY, group: toPublicGroupView(pricing.record) };
  }
  const rows = await db.productVariant.findMany({
    where: {
      OR: [
        ...(variantIds.length > 0 ? [{ id: { in: variantIds } }] : []),
        ...(productIds.length > 0 ? [{ productId: { in: productIds } }] : []),
      ],
      product: { status: "active", deletedAt: null },
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: VARIANT_SELECT,
  });
  const partner = await loadPartnerInputs(
    db,
    pricing,
    rows.map((row) => row.id),
  );
  const taxRateBps = percentToBasisPoints(settings.taxStandardRate);

  const priceOf = (row: Row): GroupPrice => {
    const input: PricingLineInput = withPartnerInput(
      {
        key: row.id,
        productId: row.productId,
        categoryIds: row.product.categories.map((entry) => entry.categoryId),
        basis: (row.priceBasis ?? row.product.priceBasis) as PriceBasis,
        priceMinor: row.price,
        salePriceMinor: activeSalePrice(row, at),
        // cantitatea nu intră în prețul unitar (resolveUnitPrice nu o folosește)
        quantity: ONE,
        step: ONE,
        taxRateBps,
        excludeFromGroupDiscount: excludedFromGroupPricing(
          row.product.excludeFromGroupDiscount,
          row.product.categories.map((entry) => entry.category.excludeFromGroupDiscount),
        ),
      },
      partner,
    );
    const options = { applySale: settings.showSalePricing };
    const standard = resolveUnitPrice(input, { ...options, group: { pricingType: "none" } });
    const grouped = resolveUnitPrice(input, { ...options, group: pricing.group });
    return { amount: grouped.unitPriceMinor, standard: standard.unitPriceMinor };
  };

  const byVariant: Record<string, GroupPrice> = {};
  const byProduct = new Map<string, GroupPrice[]>();
  for (const row of rows) {
    const price = priceOf(row);
    const list = byProduct.get(row.productId) ?? [];
    list.push(price);
    byProduct.set(row.productId, list);
    if (variantIds.includes(row.id) && price.amount < price.standard) byVariant[row.id] = price;
  }
  const products: Record<string, GroupListingPrice> = {};
  for (const productId of productIds) {
    const prices = byProduct.get(productId);
    if (!prices || !prices.some((price) => price.amount < price.standard)) continue;
    // aceeași regulă ca la prețul public al cardului: cel mai mic preț; «de la» dacă variantele diferă; tăiat doar fără interval
    let lowest = prices[0] as GroupPrice;
    for (const price of prices) if (price.amount < lowest.amount) lowest = price;
    const isRange = prices.some((price) => price.amount !== lowest.amount);
    products[productId] = { amount: lowest.amount, standard: lowest.standard, isRange };
  }
  return { group: toPublicGroupView(pricing.record), variants: byVariant, products };
}
