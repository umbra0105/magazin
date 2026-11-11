import type { ProductListQuery } from "@ecom/core";
import { getMessages } from "@/messages";
import { productsHref } from "./product-url";

/**
 * Etichetele eliminabile de sub bara de filtre a listei de produse (docs/17 §4.1), funcții PURE: doar filtrele active
 * (căutarea, categoria, brandul, starea, clasa de livrare, stocul), fiecare cu adresa care îl scoate. Sortarea, rândurile pe pagină
 * și vederea (Produse / Coș de gunoi) nu sunt filtre. Eliminarea păstrează restul și duce la prima pagină.
 */
export interface ActiveProductFilter {
  key: "q" | "category" | "brand" | "status" | "shipping" | "stock";
  /** «Categorie: Pompe» */
  label: string;
  /** «Elimină filtrul Categorie: Pompe» (nume accesibil) */
  removeLabel: string;
  href: string;
}

export interface ProductFilterLookups {
  /** Categoriile în ordinea arborelui; eticheta poate fi indentată (se curăță aici). */
  categories: readonly { id: string; label: string }[];
  brands: readonly { id: string; name: string }[];
}

export function activeProductFilters(
  query: ProductListQuery,
  lookups: ProductFilterLookups,
): ActiveProductFilter[] {
  const m = getMessages().admin.products;
  const statusText = (value: string) => (m.statuses as Record<string, string>)[value] ?? value;
  const shippingText = (value: string) => (m.shipping as Record<string, string>)[value] ?? value;
  const stockText = (value: string) => (m.stock as Record<string, string>)[value] ?? value;
  const entries: Array<{ key: ActiveProductFilter["key"]; label: string }> = [];
  if (query.q) entries.push({ key: "q", label: `${m.activeFilters.search}: ${query.q}` });
  if (query.categoryId) {
    // o categorie care nu mai e în listă își păstrează eticheta (identificatorul), ca filtrul să se poată scoate
    const name =
      lookups.categories.find((c) => c.id === query.categoryId)?.label.trim() ?? query.categoryId;
    entries.push({ key: "category", label: `${m.filters.category}: ${name}` });
  }
  if (query.brandId) {
    const name = lookups.brands.find((b) => b.id === query.brandId)?.name ?? query.brandId;
    entries.push({ key: "brand", label: `${m.filters.brand}: ${name}` });
  }
  if (query.status) {
    entries.push({ key: "status", label: `${m.filters.status}: ${statusText(query.status)}` });
  }
  if (query.shippingClass) {
    entries.push({
      key: "shipping",
      label: `${m.filters.shipping}: ${shippingText(query.shippingClass)}`,
    });
  }
  if (query.stock) {
    entries.push({ key: "stock", label: `${m.filters.stock}: ${stockText(query.stock)}` });
  }
  return entries.map(({ key, label }) => {
    const without: ProductListQuery = { ...query };
    if (key === "q") without.q = "";
    else if (key === "category") without.categoryId = null;
    else if (key === "brand") without.brandId = null;
    else if (key === "status") without.status = null;
    else if (key === "shipping") without.shippingClass = null;
    else without.stock = null;
    return {
      key,
      label,
      removeLabel: m.activeFilters.remove(label),
      href: productsHref(without, { page: 1 }),
    };
  });
}

/**
 * Câte filtre sunt în spatele butonului «Filtre (N)» de pe telefon: categoria, brandul, starea, clasa de livrare și stocul.
 * Căutarea stă mereu pe ecran (în afara panoului), deci nu se numără.
 */
export function panelFilterCount(filters: readonly ActiveProductFilter[]): number {
  return filters.filter((filter) => filter.key !== "q").length;
}
