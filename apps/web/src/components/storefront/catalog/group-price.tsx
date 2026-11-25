"use client";

import { useEffect } from "react";
import { StorePill } from "@ecom/ui";
import type { GroupPricesDto } from "@/lib/group-prices-dto";
import { getMessages } from "@/messages";
import { requestGroupPrices, useGroupPrices } from "./group-price-store";

const m = getMessages().storefront.catalog;

/**
 * Prețul de GRUP peste prețul public din pagină (Faza 15). Pe server pagina vine cu prețul public (cache ISR); aici, după
 * încărcare, clientul logat cu grup primește prețul lui, «Preț standard» tăiat și eticheta grupului, la fel pe card și pe pagina
 * produsului. Fără grup (sau fără sesiune) componentele nu schimbă nimic.
 */

type Group = NonNullable<GroupPricesDto["group"]>;

/** Textul etichetei: «Preț client fidel −5%» la reducere, «Preț partener» la partener. */
export function groupBadgeText(group: Group): string {
  if (group.pricingType === "discount" && group.discountBps !== null) {
    const percent = (group.discountBps / 100).toLocaleString("ro-RO", {
      maximumFractionDigits: 2,
    });
    return m.groupPrice.badgeDiscount(group.name, percent);
  }
  return m.groupPrice.badgePartner;
}

export function GroupBadge({ group }: { group: Group }) {
  return (
    <StorePill tone="info" data-group-badge>
      {groupBadgeText(group)}
    </StorePill>
  );
}

/** Prețul de pe un card: cel public până vine cel de grup; cu grup, prețul clientului («de la» la mai multe variante). */
export function CardPrice({ productId, fallback }: { productId: string; fallback: string }) {
  useEffect(() => requestGroupPrices({ productId }), [productId]);
  const { products } = useGroupPrices();
  const own = products[productId];
  if (!own) return <>{fallback}</>;
  return <>{own.isRange ? m.card.from(own.amountText) : own.amountText}</>;
}

/** Lângă prețul cardului: «Preț standard» tăiat (doar la un singur preț) și eticheta grupului. */
export function CardPriceExtra({ productId }: { productId: string }) {
  const { group, products } = useGroupPrices();
  const own = products[productId];
  if (!group || !own) return null;
  return (
    <>
      {own.isRange ? null : (
        <s className="text-sm text-ink-secondary" data-group-standard>
          {m.groupPrice.standard(own.standardText)}
        </s>
      )}
      <GroupBadge group={group} />
    </>
  );
}

/** Prețul variantei alese pe pagina produsului: al clientului cu grup, altfel `null` (rămâne prețul public de pe server). */
export function useVariantGroupPrice(variantId: string) {
  useEffect(() => requestGroupPrices({ variantId }), [variantId]);
  const { group, variants } = useGroupPrices();
  const own = variants[variantId];
  return group && own ? { group, ...own } : null;
}
