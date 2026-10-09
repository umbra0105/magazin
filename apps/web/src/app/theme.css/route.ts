import { configFromPreset, DEFAULT_PRESET, renderThemeCss, themeEtag } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { getBranding } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * CSS-ul temei, generat din `Branding`. Layout-ul îl cere printr-un <link rel="stylesheet"> din
 * <head>: e render-blocking, deci stilurile sunt aplicate înainte de primul paint (fără flash de
 * temă greșită), iar layout-ul nu citește DB-ul și paginile rămân statice. `no-cache` + ETag:
 * browserul revalidează la fiecare încărcare (304 ieftin), deci o temă nouă apare imediat.
 */
export async function GET(request: Request) {
  let css: string;
  let etag: string;
  let cacheControl = "no-cache";
  try {
    ({ css, etag } = await getBranding().getTheme());
  } catch (error) {
    // DB și Redis indisponibile: tema implicită, fără cache, ca site-ul să rămână lizibil.
    getLogger().error({ err: error }, "nu pot citi Branding, servesc tema implicită");
    css = renderThemeCss(configFromPreset(DEFAULT_PRESET));
    etag = themeEtag(css);
    cacheControl = "no-store";
  }

  const headers = { ETag: etag, "Cache-Control": cacheControl };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(css, {
    headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
  });
}
