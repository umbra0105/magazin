"use client";

import { useSyncExternalStore } from "react";
import { getGroupPricesAction } from "@/app/(storefront)/pret-grup/actions";
import { EMPTY_GROUP_PRICES, type GroupPricesDto } from "@/lib/group-prices-dto";

/**
 * Prețurile de grup în browser (Faza 15): UN singur exemplar per pagină. Paginile publice vin din cache cu prețul public; componentele
 * de preț cer aici, grupat într-o singură cerere, prețul clientului logat. Oaspetele și clientul fără grup primesc gol, deci pagina
 * rămâne exact cum a venit de pe server. Nu calculează nimic: păstrează textele gata formatate de server.
 */

/** Cel mult atâtea id-uri într-o cerere (serverul taie oricum la 120). */
const CHUNK = 100;

let state: GroupPricesDto = EMPTY_GROUP_PRICES;
const requested = new Set<string>();
const listeners = new Set<() => void>();
let pending: { variantIds: Set<string>; productIds: Set<string> } | null = null;

function publish(next: GroupPricesDto): void {
  state = next;
  for (const listener of listeners) listener();
}

function merge(base: GroupPricesDto, extra: GroupPricesDto): GroupPricesDto {
  if (extra.group === null) return base;
  return {
    group: extra.group,
    variants: { ...base.variants, ...extra.variants },
    products: { ...base.products, ...extra.products },
  };
}

async function flush(): Promise<void> {
  const batch = pending;
  pending = null;
  if (!batch) return;
  const chunk = <T>(values: Set<T>): T[][] => {
    const all = [...values];
    const out: T[][] = [];
    for (let i = 0; i < all.length; i += CHUNK) out.push(all.slice(i, i + CHUNK));
    return out.length > 0 ? out : [[]];
  };
  const variantChunks = chunk(batch.variantIds);
  const productChunks = chunk(batch.productIds);
  const calls = Math.max(variantChunks.length, productChunks.length);
  for (let i = 0; i < calls; i += 1) {
    try {
      const result = await getGroupPricesAction({
        variantIds: variantChunks[i] ?? [],
        productIds: productChunks[i] ?? [],
      });
      if (result.group !== null) publish(merge(state, result));
    } catch {
      // pagina rămâne cu prețul public
    }
  }
}

/** Cere prețurile de grup pentru aceste produse și variante (o singură dată per id; cererile din același moment se unesc). */
export function requestGroupPrices(request: { variantId?: string; productId?: string }): void {
  const keys: string[] = [];
  if (request.variantId) keys.push(`v:${request.variantId}`);
  if (request.productId) keys.push(`p:${request.productId}`);
  const fresh = keys.filter((key) => !requested.has(key));
  if (fresh.length === 0) return;
  for (const key of fresh) requested.add(key);
  const first = pending === null;
  pending ??= { variantIds: new Set(), productIds: new Set() };
  for (const key of fresh)
    (key.startsWith("v:") ? pending.variantIds : pending.productIds).add(key.slice(2));
  if (first) void Promise.resolve().then(flush);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGroupPrices(): GroupPricesDto {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY_GROUP_PRICES,
  );
}
