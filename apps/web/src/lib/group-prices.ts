import { loadGroupDisplayPrices, GROUP_DISPLAY_MAX_IDS } from "@ecom/core";
import { getDb } from "@ecom/db";
import { readCartSettings, resolveCartOwner } from "./cart";
import { EMPTY_GROUP_PRICES, type GroupPricesDto } from "./group-prices-dto";
import { formatPrice, getStorefrontFormat } from "./storefront-catalog";

/**
 * Prețurile de grup ale clientului curent (Faza 15), calculate DINAMIC, pe cerere, prin motorul de prețuri din nucleu. Nu trec
 * prin cache-ul paginilor (ISR) și nu se pun în nicio variantă comună: pagina publică rămâne cu prețul public, iar acest rezultat
 * ajunge doar la cel care îl cere (acțiune de server, POST, fără cache), pe baza sesiunii. Oaspetele și clientul fără grup primesc gol.
 */
export async function getGroupPrices(request: {
  variantIds: readonly string[];
  productIds: readonly string[];
}): Promise<GroupPricesDto> {
  const { owner } = await resolveCartOwner();
  if (owner.kind !== "user") return EMPTY_GROUP_PRICES;
  const [settings, format] = await Promise.all([readCartSettings(), getStorefrontFormat()]);
  const result = await loadGroupDisplayPrices(
    getDb(),
    owner.userId,
    {
      variantIds: request.variantIds.slice(0, GROUP_DISPLAY_MAX_IDS),
      productIds: request.productIds.slice(0, GROUP_DISPLAY_MAX_IDS),
    },
    { showSalePricing: settings.showSalePricing, taxStandardRate: settings.taxStandardRate },
    new Date(),
  );
  const group = result.group;
  if (group === null || group.pricingType === "none") return EMPTY_GROUP_PRICES;
  const texts = (price: { amount: number; standard: number }) => ({
    amountText: formatPrice(price.amount, format),
    standardText: formatPrice(price.standard, format),
  });
  return {
    group: {
      name: group.name,
      pricingType: group.pricingType,
      discountBps: group.discountBps,
    },
    variants: Object.fromEntries(
      Object.entries(result.variants).map(([id, price]) => [id, texts(price)]),
    ),
    products: Object.fromEntries(
      Object.entries(result.products).map(([id, price]) => [
        id,
        { ...texts(price), isRange: price.isRange },
      ]),
    ),
  };
}
