import type { StockOverviewQuery } from "@ecom/core";

/**
 * Adresa paginii Stoc, cu filtrele în adresă (`?q=&tip=&stare=&filtru=stoc-mic&pagina=`), deci pagina se poate partaja și
 * reîncărca. Fișier pur, fără componente: se folosește din server și din client, iar nucleul citește aceeași adresă
 * (`parseStockOverviewQuery`).
 */

/** Valoarea din adresă care pornește vederea «Stoc mic»; oglindește `LOW_STOCK_FILTER` din nucleu (un test le ține la fel). */
export const LOW_STOCK_FILTER = "stoc-mic";

/** Adresa listei cu interogarea curentă și, eventual, alte valori (pagina). */
export function stockHref(query: StockOverviewQuery, overrides: { page?: number } = {}): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.kind) params.set("tip", query.kind);
  if (query.state) params.set("stare", query.state);
  if (query.lowStockOnly) params.set("filtru", LOW_STOCK_FILTER);
  const page = overrides.page ?? query.page;
  if (page && page > 1) params.set("pagina", String(page));
  const text = params.toString();
  return text ? `/admin/produse/stoc?${text}` : "/admin/produse/stoc";
}
