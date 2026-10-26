import type { LowStockReason, StockOverviewQuery } from "@ecom/core";

/**
 * Adresa paginii Stoc, cu filtrele în adresă (`?q=&tip=&stare=&filtru=stoc-mic&pagina=`), deci pagina se poate partaja și
 * reîncărca. Fișier pur, fără componente: se folosește din server și din client, iar nucleul citește aceeași adresă
 * (`parseStockOverviewQuery`).
 */

/** Valoarea din adresă care pornește vederea «Stoc mic»; oglindește `LOW_STOCK_FILTER` din nucleu (un test le ține la fel). */
export const LOW_STOCK_FILTER = "stoc-mic";

/** Valoarea din adresă (`?motiv=…`) pentru fiecare motiv; oglindește `LOW_STOCK_REASON_PARAMS` din nucleu (un test le ține la fel). */
export const LOW_STOCK_REASON_PARAMS: Readonly<Record<LowStockReason, string>> = {
  out_of_stock: "epuizat",
  remainder_only: "rest-nevandabil",
  below_threshold: "sub-prag",
};

/** Adresa listei cu interogarea curentă și, eventual, alte valori (pagina). */
export function stockHref(query: StockOverviewQuery, overrides: { page?: number } = {}): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.kind) params.set("tip", query.kind);
  if (query.state) params.set("stare", query.state);
  // un motiv există doar în vederea «Stoc mic»: o pornește și ea
  if (query.lowStockOnly || query.reason) params.set("filtru", LOW_STOCK_FILTER);
  if (query.reason) params.set("motiv", LOW_STOCK_REASON_PARAMS[query.reason]);
  const page = overrides.page ?? query.page;
  if (page && page > 1) params.set("pagina", String(page));
  const text = params.toString();
  return text ? `/admin/produse/stoc?${text}` : "/admin/produse/stoc";
}
