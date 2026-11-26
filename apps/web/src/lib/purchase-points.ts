import { estimatePurchasePoints } from "@ecom/core";
import { getDb } from "@ecom/db";
import { pluralRo } from "@ecom/shared";
import { getMessages } from "@/messages";
import { readCartSettings, resolveCartOwner } from "./cart";

/**
 * Textul punctelor pentru cumpărătorul CURENT, calculat pe cerere prin motorul de prețuri din nucleu (nu trece prin cache-ul
 * paginilor). `null` = nu se arată nimic (program oprit, partener, sub un punct).
 */
export async function getPurchasePointsNote(request: {
  variantId: string;
  quantityTicks: bigint;
}): Promise<string | null> {
  const { owner } = await resolveCartOwner();
  const settings = await readCartSettings();
  const estimate = await estimatePurchasePoints(
    getDb(),
    owner.kind === "user" ? owner.userId : null,
    request,
    { showSalePricing: settings.showSalePricing, taxStandardRate: settings.taxStandardRate },
    new Date(),
  );
  if (!estimate) return null;
  const text = getMessages().storefront.checkout.loyalty;
  const points = pluralRo(estimate.points, "punct", "puncte", "de puncte");
  return estimate.audience === "guest" ? text.pdpGuest(points) : text.pdpMember(points);
}
