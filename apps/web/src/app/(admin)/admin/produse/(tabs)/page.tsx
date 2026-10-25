import type { Metadata } from "next";
import Link from "next/link";
import {
  MAX_BULK_PRODUCTS,
  PRODUCT_LIST_PAGE_SIZES,
  PRODUCT_LIST_SORTS,
  PRODUCT_STATUSES,
  SHIPPING_CLASSES,
  STOCK_STATUSES,
  can,
  childrenOf,
  type CategoryNode,
} from "@ecom/core";
import { Button, Input, Label, Select, buttonVariants } from "@ecom/ui";
import { ProductTable, type ProductTableRow } from "@/components/admin/products/product-table";
import { requireAdmin } from "@/lib/admin-page";
import { getBrandService, getCategoryService, getProductListService } from "@/lib/catalog";
import { getStockOverviewService } from "@/lib/inventory";
import { getSettings } from "@/lib/services";
import { summaryView, type SummaryView } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.products;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Lista de produse. Cere `products.read`. Căutarea, filtrele, sortarea și pagina sunt în URL
 * (formular GET: merge și fără JavaScript, se poate trimite ca link) și se aplică PE SERVER. Rândurile
 * vin din `ProductListService`: fără cost, doar `thumb`. Titlul se editează cu
 * `products.content.write`; starea, stocul, prețul și acțiunile în masă cer `products.write`.
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const subject = await requireAdmin({ permission: "products.read" });
  const params = await searchParams;

  const [{ query, page }, categoryRows, brands, regional] = await Promise.all([
    getProductListService().list(subject, params),
    getCategoryService().tree(subject),
    getBrandService().list(subject),
    getSettings().getGroup("regional"),
  ]);

  // Categoriile în ordinea arborelui, cu indentare pentru selectoare.
  const nodes: CategoryNode[] = categoryRows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    slug: c.slug,
    name: c.name,
    path: c.path,
    depth: c.depth,
    sortOrder: c.sortOrder,
  }));
  const categories: { id: string; label: string }[] = [];
  const walk = (parentId: string | null) => {
    for (const node of childrenOf(nodes, parentId)) {
      categories.push({ id: node.id, label: `${"  ".repeat(node.depth)}${node.name}` });
      walk(node.id);
    }
  };
  walk(null);

  const trash = query.view === "deleted";
  const canWrite = can(subject, "products.write");
  const canEditContent = can(subject, "products.content.write");
  const canExport = can(subject, "products.export");

  // Coloana «Stoc»: starea cea mai bună dintre variante și cantitatea (doar cu `inventory.read`); o singură interogare pentru pagină.
  const stock: Record<string, SummaryView> = {};
  if (!trash && page.rows.length > 0) {
    try {
      const summaries = await getStockOverviewService().summaries(
        subject,
        page.rows.map((r) => r.id),
      );
      for (const [productId, summary] of summaries) stock[productId] = summaryView(summary);
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "STOCK_NO_WAREHOUSE") throw error;
    }
  }

  const rows: ProductTableRow[] = page.rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    brandName: r.brandName,
    shippingClass: r.shippingClass,
    manageStock: r.manageStock,
    stockStatus: r.stockStatus,
    variantCount: r.variantCount,
    priceMin: r.priceMin,
    priceMax: r.priceMax,
    sku: r.sku,
    singleVariantId: r.singleVariantId,
    categoryNames: r.categoryNames,
    thumb: r.thumb,
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  }));

  const hrefWith = (target: number): string => {
    const search = new URLSearchParams();
    if (trash) search.set("view", "deleted");
    if (query.q) search.set("q", query.q);
    if (query.categoryId) search.set("category", query.categoryId);
    if (query.brandId) search.set("brand", query.brandId);
    if (query.status) search.set("status", query.status);
    if (query.shippingClass) search.set("shipping", query.shippingClass);
    if (query.stock) search.set("stock", query.stock);
    if (query.sort !== "updated_desc") search.set("sort", query.sort);
    if (query.pageSize !== 25) search.set("size", String(query.pageSize));
    if (target > 1) search.set("page", String(target));
    const qs = search.toString();
    return `/admin/produse${qs ? `?${qs}` : ""}`;
  };

  // filtrele listei, ca parametri (exportul le aplică pe server, la fel ca lista)
  const exportFilters: Record<string, string> = {
    ...(trash && { view: "deleted" }),
    ...(query.q && { q: query.q }),
    ...(query.categoryId && { category: query.categoryId }),
    ...(query.brandId && { brand: query.brandId }),
    ...(query.status && { status: query.status }),
    ...(query.shippingClass && { shipping: query.shippingClass }),
    ...(query.stock && { stock: query.stock }),
  };

  const filtered = Boolean(
    query.q ||
    query.categoryId ||
    query.brandId ||
    query.status ||
    query.shippingClass ||
    query.stock,
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{m.title}</h1>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/produse/import" className={buttonVariants({ variant: "outline" })}>
                {getMessages().admin.productImport.openButton}
              </Link>
              <Link href="/admin/produse/nou" className={buttonVariants({ variant: "default" })}>
                {m.editor.newButton}
              </Link>
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{m.description}</p>
        <nav aria-label={m.views.label} className="mt-2 flex gap-2" data-product-views>
          <Link
            href="/admin/produse"
            aria-current={trash ? undefined : "page"}
            className={buttonVariants({ variant: trash ? "outline" : "default", size: "sm" })}
          >
            {m.views.active}
          </Link>
          <Link
            href="/admin/produse?view=deleted"
            aria-current={trash ? "page" : undefined}
            className={buttonVariants({ variant: trash ? "default" : "outline", size: "sm" })}
          >
            {m.views.deleted}
          </Link>
        </nav>
        {trash && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.views.deletedNote}
          </p>
        )}
        {!canWrite && !canEditContent && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.readOnly}
          </p>
        )}
        {!canWrite && canEditContent && (
          <p role="note" className="mt-2 rounded-md border border-border bg-border/30 p-3 text-sm">
            {m.contentOnly}
          </p>
        )}
      </header>

      <form
        method="get"
        action="/admin/produse"
        role="search"
        className="flex flex-col gap-3 rounded-md border border-border p-3"
      >
        {trash && <input type="hidden" name="view" value="deleted" />}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
            <Label htmlFor="product-q">{m.search.label}</Label>
            <Input
              id="product-q"
              name="q"
              type="search"
              defaultValue={query.q}
              placeholder={m.search.placeholder}
              maxLength={100}
            />
          </div>
          <Button type="submit">{m.search.submit}</Button>
          {filtered && (
            <Link
              href={trash ? "/admin/produse?view=deleted" : "/admin/produse"}
              className={buttonVariants({ variant: "outline" })}
            >
              {m.search.reset}
            </Link>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-category">{m.filters.category}</Label>
            <Select id="f-category" name="category" defaultValue={query.categoryId ?? ""}>
              <option value="">{m.filters.all}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-brand">{m.filters.brand}</Label>
            <Select id="f-brand" name="brand" defaultValue={query.brandId ?? ""}>
              <option value="">{m.filters.all}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-status">{m.filters.status}</Label>
            <Select id="f-status" name="status" defaultValue={query.status ?? ""}>
              <option value="">{m.filters.all}</option>
              {PRODUCT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {m.statuses[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-shipping">{m.filters.shipping}</Label>
            <Select id="f-shipping" name="shipping" defaultValue={query.shippingClass ?? ""}>
              <option value="">{m.filters.all}</option>
              {SHIPPING_CLASSES.map((s) => (
                <option key={s} value={s}>
                  {m.shipping[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-stock">{m.filters.stock}</Label>
            <Select id="f-stock" name="stock" defaultValue={query.stock ?? ""}>
              <option value="">{m.filters.all}</option>
              {STOCK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {m.stock[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-sort">{m.filters.sort}</Label>
            <Select id="f-sort" name="sort" defaultValue={query.sort}>
              {PRODUCT_LIST_SORTS.map((s) => (
                <option key={s} value={s}>
                  {m.sorts[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="f-size">{m.filters.perPage}</Label>
            <Select id="f-size" name="size" defaultValue={String(query.pageSize)}>
              {PRODUCT_LIST_PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </form>

      <p className="text-sm text-muted-foreground" data-product-total>
        {m.total(page.total)}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          {trash
            ? filtered
              ? m.views.emptyDeletedFiltered
              : m.views.emptyDeleted
            : filtered
              ? m.emptyFiltered
              : m.empty}
        </p>
      ) : (
        <ProductTable
          rows={rows}
          canWrite={canWrite}
          canEditContent={canEditContent}
          currency={regional.currency}
          locale={regional.locale}
          maxBulk={MAX_BULK_PRODUCTS}
          categories={categories}
          brands={brands.map((b) => ({ id: b.id, name: b.name }))}
          view={trash ? "deleted" : "active"}
          stock={stock}
          {...(canExport && {
            exportTools: { filters: exportFilters, filteredTotal: page.total },
          })}
        />
      )}

      {page.pageCount > 1 && (
        <nav
          aria-label={m.pagination.label}
          className="flex flex-wrap items-center justify-between gap-2"
        >
          {page.page > 1 ? (
            <Link
              href={hrefWith(page.page - 1)}
              rel="prev"
              className={buttonVariants({ variant: "outline" })}
            >
              {m.pagination.previous}
            </Link>
          ) : (
            <span />
          )}
          <span
            className="order-last w-full text-center text-sm sm:order-none sm:w-auto"
            aria-current="page"
          >
            {m.pagination.pageOf(page.page, page.pageCount)}
          </span>
          {page.page < page.pageCount ? (
            <Link
              href={hrefWith(page.page + 1)}
              rel="next"
              className={buttonVariants({ variant: "outline" })}
            >
              {m.pagination.next}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
