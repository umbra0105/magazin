"use server";

import { z } from "zod";
import { getGroupPrices } from "@/lib/group-prices";
import { EMPTY_GROUP_PRICES, type GroupPricesDto } from "@/lib/group-prices-dto";

/**
 * Prețurile de grup pentru paginile de vitrină (Faza 15). O acțiune de server (POST, niciodată în cache) apelată din browser după
 * încărcarea paginii: pagina publică rămâne cu prețul public, iar clientul cu grup primește peste ea prețul lui. Fără sesiune sau
 * fără grup cu preț special întoarce gol. Intrarea e validată și limitată.
 */
const ids = z.array(z.string().min(1).max(64)).max(120);
const request = z.object({ variantIds: ids.default([]), productIds: ids.default([]) });

export async function getGroupPricesAction(input: unknown): Promise<GroupPricesDto> {
  const parsed = request.safeParse(input);
  if (!parsed.success) return EMPTY_GROUP_PRICES;
  try {
    return await getGroupPrices(parsed.data);
  } catch {
    // vitrina rămâne cu prețul public (nu blocăm pagina pentru un preț de grup)
    return EMPTY_GROUP_PRICES;
  }
}
