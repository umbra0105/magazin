import { X } from "lucide-react";
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
import {
  Button,
  EmptyState,
  Input,
  Label,
  Pagination,
  Select,
  TAB_LIST_CLASS,
  buttonVariants,
  filterChipClass,
  tabClass,
} from "@ecom/ui";
import { ProductExportAction } from "@/components/admin/products/product-export-action";
import { ProductSelectionProvider } from "@/components/admin/products/product-selection";
import { ProductTable, type ProductTableRow } from "@/components/admin/products/product-table";
import { RowsPerPage } from "@/components/admin/products/rows-per-page";
import { requireAdmin } from "@/lib/admin-page";
import { getBrandService, getCategoryService, getProductListService } from "@/lib/catalog";
import { getStockOverviewService } from "@/lib/inventory";
import { activeProductFilters } from "@/lib/product-filters";
import { productsHref } from "@/lib/product-url";
import { getSettings } from "@/lib/services";
import { summaryView, type SummaryView } from "@/lib/stock-view";
import { getMessages } from "@/messages";

const m = getMessages().admin.products;

export const metadata: Metadata = { title: m.title };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Lista de produse (docs/17 §4.1). Cere `products.read`. Căutarea, filtrele, sortarea și pagina sunt în URL
 * (formular GET: merge și fără JavaScript, se poate trimite ca link) și se aplică PE SERVER. Rândurile
 * vin din `ProductListService`: fără cost, doar `thumb`. Titlul se editează cu
 * `products.content.write`; starea, stocul, prețul și acțiunile în masă cer `products.write`. Titlul are numărul de produse,
 * vederile (Produse / Coș de gunoi) sunt tab-uri-legături, bara de unelte are Exportă, Import și Produs nou, iar filtrele
 * active se văd ca etichete eliminabile sub bara de filtre.
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
      categories.push({ id: node.id, label: `${"  ".repeat(node.depth)}${node.name}` });
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
    sale: r.sale,
    thumb: r.thumb,
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  }));

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

  const chips = activeProductFilters(query, { categories, brands });
  const filtered = chips.length > 0;
  const viewHref = trash ? "/admin/produse?view=deleted" : "/admin/produse";
  const views = [
    { id: "active", label: m.views.active, href: "/admin/produse" },
    { id: "deleted", label: m.views.deleted, href: "/admin/produse?view=deleted" },
  ] as const;

  return (
    <ProductSelectionProvider key={productsHref(query)}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-title">
              {m.title}{" "}
              <span className="font-normal text-ink-secondary">
                ({page.total.toLocaleString("ro-RO")})
              </span>
            </h1>
            <div className="flex flex-wrap gap-2" data-product-toolbar>
              {canExport && (
                <ProductExportAction
                  filters={exportFilters}
                  filteredTotal={page.total}
                  trashView={trash}
                />
              )}
              {canWrite && (
                <Link
                  href="/admin/produse/import"
                  className={buttonVariants({ variant: "outline" })}
                >
                  {getMessages().admin.productImport.openButton}
                </Link>
              )}
              {canWrite && (
                <Link href="/admin/produse/nou" className={buttonVariants({ variant: "default" })}>
                  {m.editor.newButton}
                </Link>
              )}
            </div>
          </div>
          <p className="text-body text-ink-secondary">{m.description}</p>
          {!canWrite && !canEditContent && (
            <p role="note" className="mt-2 rounded-lg bg-surface-subtle p-3 text-body">
              {m.readOnly}
            </p>
          )}
          {!canWrite && canEditContent && (
            <p role="note" className="mt-2 rounded-lg bg-surface-subtle p-3 text-body">
              {m.contentOnly}
            </p>
          )}
        </header>

        <nav aria-label={m.views.label} className={TAB_LIST_CLASS} data-product-views>
          {views.map((view) => {
            const current = (view.id === "deleted") === trash;
            return (
              <Link
                key={view.id}
                href={view.href}
                aria-current={current ? "page" : undefined}
                className={tabClass(current)}
              >
                {view.label}
              </Link>
            );
          })}
        </nav>
        {trash && (
          <p role="note" className="rounded-lg bg-surface-subtle p-3 text-body">
            {m.views.deletedNote}
          </p>
        )}

        <form
          // se remontează când se schimbă adresa (o etichetă de filtru scoasă, pagina): câmpurile sunt necontrolate
          key={productsHref(query)}
          method="get"
          action="/admin/produse"
          noValidate
          role="search"
          className="flex flex-col gap-3"
        >
          {trash && <input type="hidden" name="view" value="deleted" />}
          {/* rândurile pe pagină alese rămân la căutare; 25 (implicit) nu se scrie în adresă */}
          {query.pageSize !== 25 && <input type="hidden" name="size" value={query.pageSize} />}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-56 flex-1 flex-col gap-1.5">
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
            <div className="flex gap-2">
              <Button type="submit">{m.search.submit}</Button>
              {filtered && (
                <Link href={viewHref} className={buttonVariants({ variant: "outline" })}>
                  {m.search.reset}
                </Link>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-sort">{m.filters.sort}</Label>
              <Select id="f-sort" name="sort" defaultValue={query.sort}>
                {PRODUCT_LIST_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {m.sorts[s]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </form>

        {chips.length > 0 && (
          <ul
            aria-label={m.activeFilters.label}
            data-active-filters
            className="flex flex-wrap gap-2"
          >
            {chips.map((chip) => (
              <li key={chip.key}>
                <Link
                  href={chip.href}
                  aria-label={chip.removeLabel}
                  data-filter={chip.key}
                  className={filterChipClass}
                >
                  {chip.label}
                  <X aria-hidden="true" className="size-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* numărul se vede în titlu; aici rămâne pentru cititoarele de ecran și pentru teste */}
        <p className="sr-only" data-product-total>
          {m.total(page.total)}
        </p>

        {rows.length === 0 ? (
          <EmptyState
            title={
              trash
                ? filtered
                  ? m.views.emptyDeletedFiltered
                  : m.views.emptyDeleted
                : filtered
                  ? m.emptyFiltered
                  : m.empty
            }
            {...(filtered && {
              action: (
                <Link href={viewHref} className={buttonVariants({ variant: "outline" })}>
                  {m.filters.clearAll}
                </Link>
              ),
            })}
          />
        ) : (
          <ProductTable
            rows={rows}
            canWrite={canWrite}
            canEditContent={canEditContent}
            canExport={canExport}
            currency={regional.currency}
            locale={regional.locale}
            maxBulk={MAX_BULK_PRODUCTS}
            categories={categories}
            brands={brands.map((b) => ({ id: b.id, name: b.name }))}
            view={trash ? "deleted" : "active"}
            stock={stock}
          />
        )}

        {page.total > (PRODUCT_LIST_PAGE_SIZES[0] ?? 25) && (
          <Pagination
            label={m.pagination.label}
            page={page.page}
            pageCount={page.pageCount}
            hrefFor={(target) => productsHref(query, { page: target })}
            previousLabel={m.pagination.previous}
            nextLabel={m.pagination.next}
            pageLabel={m.pagination.pageNumber}
            summary={m.pagination.pageOf}
            renderLink={({ href, children, ...rest }) => (
              <Link href={href} {...rest}>
                {children}
              </Link>
            )}
            start={
              <RowsPerPage
                value={query.pageSize}
                options={PRODUCT_LIST_PAGE_SIZES.map((size) => ({
                  size,
                  href: productsHref(query, { pageSize: size }),
                }))}
              />
            }
          />
        )}
      </div>
    </ProductSelectionProvider>
  );
}
