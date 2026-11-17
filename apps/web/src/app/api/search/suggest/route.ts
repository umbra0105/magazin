import { NextResponse } from "next/server";
import { isSearchable, resolveClientIp } from "@ecom/core";
import { formatPrice, getCatalogReader, getStorefrontFormat } from "@/lib/storefront-catalog";
import { getCounterStore, getSettings } from "@/lib/services";
import { categoryHref, productHref } from "@/lib/storefront-urls";

export const dynamic = "force-dynamic";

/** Sugestii pe minut și adresă: autocomplete-ul trimite o cerere la fiecare pauză de tastare, deci plafonul e generos, dar finit. */
const PER_IP_PER_MINUTE = 120;
const UNKNOWN_IP_PER_MINUTE = 1200;
const WINDOW_SECONDS = 60;
const MAX_QUERY_LENGTH = 80;
const LIMIT = 6;

/**
 * Autocomplete-ul căutării (public, doar citire): produse, categorii și mărci care încep cu textul. Interogarea e normalizată și
 * parametrizată în nucleu; limitat pe IP; răspunsul nu conține costuri, cantități de stoc sau date personale.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
  if (!isSearchable(q)) return NextResponse.json({ products: [], categories: [], brands: [] });

  const { trustedProxyHops } = await getSettings().getGroup("auth");
  const ip = resolveClientIp(request.headers, trustedProxyHops);
  const counter = await getCounterStore().increment(`suggest:${ip ?? "unknown"}`, WINDOW_SECONDS);
  if (counter.count > (ip ? PER_IP_PER_MINUTE : UNKNOWN_IP_PER_MINUTE)) {
    return NextResponse.json(
      { code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(counter.ttlSeconds) } },
    );
  }

  const format = await getStorefrontFormat();
  const found = await getCatalogReader().suggest(q, LIMIT, format);
  return NextResponse.json(
    {
      products: found.products.map((product) => ({
        title: product.title,
        href: productHref(product.slug),
        image: product.image ? { src: product.image.src, alt: product.image.alt } : null,
        price: product.price ? formatPrice(product.price.amount, format) : null,
      })),
      categories: found.categories.map((c) => ({ name: c.name, href: categoryHref(c.path) })),
      brands: found.brands.map((b) => ({ name: b.name, href: `/brand/${b.slug}` })),
    },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
