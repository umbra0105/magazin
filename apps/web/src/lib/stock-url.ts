import type { LowStockReason, StockOverviewQuery } from "@ecom/core";

/**
 * Adresa paginii Stoc, cu filtrele în adresă (`?q=&tip=&stare=&filtru=stoc-mic&pe-pagina=&pagina=`), deci pagina se poate partaja și
 * reîncărca. Fișier pur, fără componente: se folosește din server și din client, iar nucleul citește aceeași adresă
 * (`parseStockOverviewQuery`).
 */

/** Valoarea din adresă care pornește vederea «Stoc mic»; oglindește `LOW_STOCK_FILTER` din nucleu (un test le ține la fel). */
export const LOW_STOCK_FILTER = "stoc-mic";

/** Rândurile pe pagină implicite (nu se scriu în adresă); oglindește `STOCK_LIST_PAGE_SIZE` din nucleu (un test le ține la fel). */
export const DEFAULT_PAGE_SIZE = 25;

/** Valoarea din adresă (`?motiv=…`) pentru fiecare motiv; oglindește `LOW_STOCK_REASON_PARAMS` din nucleu (un test le ține la fel). */
export const LOW_STOCK_REASON_PARAMS: Readonly<Record<LowStockReason, string>> = {
  out_of_stock: "epuizat",
  remainder_only: "rest-nevandabil",
  below_threshold: "sub-prag",
};

/**
 * Interogarea din adresă + depozitul ales (`?depozit=<cod>`, 13d). Codul îl pune pagina DOAR când selectorul e vizibil și
 * depozitul ales nu e cel implicit; nucleul nu citește parametrul (îl rezolvă `getWarehouseChoice`, cu steagul pornit).
 */
export type StockUrlQuery = StockOverviewQuery & { warehouseCode?: string };

/** Adresa listei cu interogarea curentă și, eventual, alte valori (pagina). */
export function stockHref(query: StockUrlQuery, overrides: { page?: number } = {}): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.kind) params.set("tip", query.kind);
  if (query.state) params.set("stare", query.state);
  // un motiv există doar în vederea «Stoc mic»: o pornește și ea
  if (query.lowStockOnly || query.reason) params.set("filtru", LOW_STOCK_FILTER);
  if (query.reason) params.set("motiv", LOW_STOCK_REASON_PARAMS[query.reason]);
  if (query.warehouseCode) params.set("depozit", query.warehouseCode);
  // 25 e valoarea implicită: nu se scrie în adresă
  if (query.pageSize && query.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pe-pagina", String(query.pageSize));
  }
  const page = overrides.page ?? query.page;
  if (page && page > 1) params.set("pagina", String(page));
  const text = params.toString();
  return text ? `/admin/produse/stoc?${text}` : "/admin/produse/stoc";
}

/** Adresa istoricului unei variante; poartă depozitul ales (`?depozit=`) când nu e cel implicit */
export function historyHref(variantId: string, warehouseCode?: string | null): string {
  const base = `/admin/produse/stoc/${variantId}`;
  return warehouseCode ? `${base}?depozit=${encodeURIComponent(warehouseCode)}` : base;
}
