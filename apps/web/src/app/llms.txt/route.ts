import { loadEnv } from "@ecom/config";
import { getCatalogReader } from "@/lib/storefront-catalog";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { renderLlmsTxt } from "@/lib/seo-files";

export const dynamic = "force-dynamic";

/** /llms.txt generat din date reale: numele magazinului, categoriile din meniu și mărcile cu produse active. */
export async function GET(): Promise<Response> {
  const [chrome, brands] = await Promise.all([
    getStorefrontChrome(),
    getCatalogReader().listBrands(50),
  ]);
  const text = renderLlmsTxt({
    base: loadEnv().APP_URL,
    storeName: chrome.storeName,
    tagline: chrome.tagline,
    categories: chrome.menu.map((node) => ({
      name: node.name,
      path: node.href.replace(/^\/categorie\//, ""),
    })),
    brands: brands.map((b) => ({ name: b.name, slug: b.slug })),
  });
  return new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600",
    },
  });
}
