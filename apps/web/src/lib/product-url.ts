import type { ProductListQuery } from "@ecom/core";

/**
 * Adresa listei de produse, cu filtrele în adresă (`?view=&q=&category=&brand=&status=&shipping=&stock=&sort=&size=&page=`):
 * pagina se poate partaja și reîncărca, iar nucleul citește aceiași parametri (`parseProductListQuery`). Fișier pur, fără
 * componente, ca să-l poată folosi și serverul, și clientul.
 */

/** Valorile implicite nu se scriu în adresă (oglindesc `parseProductListQuery`; un test citește adresa înapoi prin nucleu). */
const DEFAULT_SORT = "updated_desc";
const DEFAULT_PAGE_SIZE = 25;

export function productsHref(
  query: ProductListQuery,
  overrides: { page?: number; pageSize?: number } = {},
): string {
  const pageSize = overrides.pageSize ?? query.pageSize;
  // rândurile pe pagină schimbate duc la prima pagină: pagina veche ar putea să nu mai existe
  const page = overrides.page ?? (overrides.pageSize !== undefined ? 1 : query.page);
  const params = new URLSearchParams();
  if (query.view === "deleted") params.set("view", "deleted");
  if (query.q) params.set("q", query.q);
  if (query.categoryId) params.set("category", query.categoryId);
  if (query.brandId) params.set("brand", query.brandId);
  if (query.status) params.set("status", query.status);
  if (query.shippingClass) params.set("shipping", query.shippingClass);
  if (query.stock) params.set("stock", query.stock);
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set("size", String(pageSize));
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/admin/produse?${text}` : "/admin/produse";
}
