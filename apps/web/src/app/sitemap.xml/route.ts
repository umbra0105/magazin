import { loadEnv } from "@ecom/config";
import { getCatalogReader } from "@/lib/storefront-catalog";
import { renderSitemap, type SitemapEntry } from "@/lib/seo-files";
import { SHOP_PATH, brandHref, categoryHref, productHref } from "@/lib/storefront-urls";

export const dynamic = "force-dynamic";

/** Sitemap-ul catalogului din date reale: adresa canonică a fiecărui produs, categorie și marcă, cu `lastmod` și imaginea principală. */
export async function GET(): Promise<Response> {
  const base = loadEnv().APP_URL.replace(/\/+$/, "");
  const source = await getCatalogReader().listSitemapSource();
  const entries: SitemapEntry[] = [
    { loc: `${base}/` },
    { loc: `${base}${SHOP_PATH}` },
    ...source.categories.map((c) => ({
      loc: `${base}${categoryHref(c.path)}`,
      lastmod: c.updatedAt,
    })),
    ...source.brands.map((b) => ({ loc: `${base}${brandHref(b.slug)}`, lastmod: b.updatedAt })),
    ...source.products.map((p) => ({
      loc: `${base}${productHref(p.slug)}`,
      lastmod: p.updatedAt,
      ...(p.image ? { image: { loc: p.image, title: p.title } } : {}),
    })),
  ];
  return new Response(renderSitemap(entries), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
