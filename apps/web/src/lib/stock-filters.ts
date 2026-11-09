import { getMessages } from "@/messages";
import { stockHref, type StockUrlQuery } from "./stock-url";

/**
 * Etichetele eliminabile de sub bara de filtre a paginii Stoc (docs/17 §4.1), funcții PURE: doar filtrele active (căutarea, tipul,
 * starea), fiecare cu adresa care îl scoate. Vederea «Stoc mic» și motivul nu sunt etichete: sunt tab-ul și cardurile de numărători.
 * Eliminarea păstrează vederea, depozitul și rândurile pe pagină și duce la prima pagină.
 */
export interface ActiveStockFilter {
  key: "search" | "kind" | "state";
  /** «Tip: Gestionat» */
  label: string;
  /** «Elimină filtrul Tip: Gestionat» (nume accesibil) */
  removeLabel: string;
  href: string;
}

export function activeStockFilters(query: StockUrlQuery): ActiveStockFilter[] {
  const m = getMessages().admin.inventory;
  const entries: Array<{ key: ActiveStockFilter["key"]; label: string }> = [];
  if (query.search)
    entries.push({ key: "search", label: `${m.activeFilters.search}: ${query.search}` });
  if (query.kind) {
    entries.push({ key: "kind", label: `${m.activeFilters.kind}: ${m.filters.kinds[query.kind]}` });
  }
  if (query.state) {
    entries.push({ key: "state", label: `${m.activeFilters.state}: ${m.states[query.state]}` });
  }
  return entries.map(({ key, label }) => {
    const without: StockUrlQuery = { ...query };
    if (key === "search") delete without.search;
    else if (key === "kind") delete without.kind;
    else delete without.state;
    return {
      key,
      label,
      removeLabel: m.activeFilters.remove(label),
      href: stockHref({ ...without, page: 1 }),
    };
  });
}
