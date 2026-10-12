import { configFromPreset, DEFAULT_PRESET, renderPaletteCss, themeEtag } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { getBranding } from "./services";

/**
 * Foaia cu o singură paletă (luminoasă sau întunecată) a magazinului, pentru alegerea de temă din
 * admin. Aceleași reguli ca `/theme.css`: `no-cache` + ETag (revalidare ieftină), temă implicită
 * dacă DB și Redis nu răspund.
 */
export async function servePalette(mode: "light" | "dark", request: Request): Promise<Response> {
  let css: string;
  let etag: string;
  let cacheControl = "no-cache";
  try {
    ({ css, etag } = await getBranding().getPalette(mode));
  } catch (error) {
    getLogger().error({ err: error, mode }, "nu pot citi Branding, servesc paleta implicită");
    css = renderPaletteCss(configFromPreset(DEFAULT_PRESET).colors[mode]);
    etag = themeEtag(css);
    cacheControl = "no-store";
  }
  const headers = { ETag: etag, "Cache-Control": cacheControl };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(css, { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
}
