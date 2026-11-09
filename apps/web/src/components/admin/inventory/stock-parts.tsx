import Link from "next/link";
import type { LowStockCounts, WarehouseFreshness } from "@ecom/core";
import {
  Badge,
  Button,
  Input,
  Label,
  Pagination,
  SegmentedBar,
  Select,
  TAB_LIST_CLASS,
  buttonVariants,
  cn,
  filterChipClass,
  tabClass,
} from "@ecom/ui";
import { X } from "lucide-react";
import { activeStockFilters } from "@/lib/stock-filters";
import { stockHealthView } from "@/lib/stock-health";
import { LOW_STOCK_FILTER, stockHref, type StockUrlQuery } from "@/lib/stock-url";
import { badgeVariant, snapshotView } from "@/lib/stock-view";
import { getMessages } from "@/messages";
import { PageSizeSelect } from "./page-size-select";

const m = getMessages().admin.inventory;

/** Banner-ul «Sincronizare SmartBill»: pastila stării (La zi / Neactualizat / Neimportat) și explicația. Alertă când nu s-a importat nimic. */
export function FreshnessBanner({ freshness }: { freshness: WarehouseFreshness | null }) {
  const view = snapshotView(freshness);
  return (
    <div
      role={view.tone === "danger" ? "alert" : "status"}
      aria-label={m.banner.label}
      data-banner={freshness?.status ?? "none"}
      data-tone={view.tone}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-subtle px-4 py-3 text-body"
    >
      <Badge variant={badgeVariant(view.tone)} dot>
        {view.label}
      </Badge>
      <span>{view.text}</span>
    </div>
  );
}

/**
 * Starea stocului în bara segmentată (în stoc / stoc mic / epuizat), din variantele gestionate, cu legenda dedesubt. Fără variante
 * gestionate nu se desenează nimic. În Panou are titlu vizibil (`heading`); în pagina Stoc, bara stă sub banner, fără titlu.
 */
export function StockHealth({
  lowStock,
  managedVariants,
  heading = false,
}: {
  lowStock: LowStockCounts;
  managedVariants: number;
  heading?: boolean;
}) {
  const view = stockHealthView(lowStock, managedVariants);
  if (!view) return null;
  return (
    <section aria-label={view.label} data-stock-health className="flex flex-col gap-3">
      {heading && <h3 className="text-section">{view.label}</h3>}
      <SegmentedBar segments={view.segments} label={view.label} />
      <p className="text-label text-ink-secondary">{view.caption}</p>
    </section>
  );
}

/** Filtrele listei: formular GET (funcționează fără JavaScript), fără validare nativă. */
export function StockFilters({ query }: { query: StockUrlQuery }) {
  const f = m.filters;
  return (
    <form
      // se remontează când se schimbă adresa (comutatorul de vedere, pagina): câmpurile sunt necontrolate (`default…`) și altfel
      // ar păstra valorile vechi, de exemplu bifa «Doar stoc mic» nebifată după trecerea în vederea «Stoc mic»
      key={stockHref(query)}
      method="get"
      action="/admin/produse/stoc"
      noValidate
      role="search"
      aria-label={f.label}
      className="flex flex-wrap items-end gap-3"
    >
      {/* depozitul ales rămâne la căutare (13d); fără el formularul GET ar duce înapoi la depozitul implicit */}
      {query.warehouseCode && <input type="hidden" name="depozit" value={query.warehouseCode} />}
      {/* rândurile pe pagină alese rămân la căutare; 25 (implicit) nu se scrie în adresă */}
      {query.pageSize && query.pageSize !== 25 && (
        <input type="hidden" name="pe-pagina" value={query.pageSize} />
      )}
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="stock-search">{f.search}</Label>
        <Input
          id="stock-search"
          name="q"
          defaultValue={query.search ?? ""}
          placeholder={f.searchPlaceholder}
          maxLength={100}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stock-kind">{f.kind}</Label>
        <Select id="stock-kind" name="tip" defaultValue={query.kind ?? ""}>
          <option value="">{f.all}</option>
          {(["managed", "unmanaged", "digital"] as const).map((kind) => (
            <option key={kind} value={kind}>
              {f.kinds[kind]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stock-state">{f.state}</Label>
        <Select id="stock-state" name="stare" defaultValue={query.state ?? ""}>
          <option value="">{f.all}</option>
          {(["in_stock", "limited", "on_order", "unavailable"] as const).map((state) => (
            <option key={state} value={state}>
              {m.states[state]}
            </option>
          ))}
        </Select>
      </div>
      <label className="flex min-h-(--control-h) items-center gap-2 text-body">
        <input
          type="checkbox"
          name="filtru"
          value={LOW_STOCK_FILTER}
          defaultChecked={query.lowStockOnly === true}
          className="size-4 accent-brand"
        />
        {f.lowOnly}
      </label>
      <div className="flex gap-2">
        <Button type="submit">{f.apply}</Button>
        <Link
          href={stockHref({
            ...(query.warehouseCode && { warehouseCode: query.warehouseCode }),
            ...(query.pageSize && { pageSize: query.pageSize }),
          })}
          className={buttonVariants({ variant: "outline" })}
        >
          {f.reset}
        </Link>
      </div>
    </form>
  );
}

/** Filtrele active ca etichete eliminabile, sub bara de filtre. Fără filtre active nu se desenează nimic. */
export function ActiveFilters({ query }: { query: StockUrlQuery }) {
  const filters = activeStockFilters(query);
  if (filters.length === 0) return null;
  return (
    <ul aria-label={m.activeFilters.label} data-active-filters className="flex flex-wrap gap-2">
      {filters.map((filter) => (
        <li key={filter.key}>
          <Link
            href={filter.href}
            aria-label={filter.removeLabel}
            data-filter={filter.key}
            className={filterChipClass}
          >
            {filter.label}
            <X aria-hidden="true" className="size-3.5" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Paginarea (docs/17 §3). Legăturile păstrează filtrele din adresă. Cu `sizes` (doar pagina Stoc), în stânga apare selectorul
 * «Rânduri pe pagină», iar bara rămâne și la o singură pagină, ca să te poți întoarce la mai puține rânduri.
 */
export function Pager({
  page,
  pageCount,
  hrefFor,
  sizes,
  query,
  pageSize,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  sizes?: readonly number[];
  query?: StockUrlQuery;
  pageSize?: number;
}) {
  const p = m.pagination;
  return (
    <Pagination
      label={p.label}
      page={page}
      pageCount={pageCount}
      hrefFor={hrefFor}
      previousLabel={p.previous}
      nextLabel={p.next}
      pageLabel={p.pageNumber}
      summary={p.page}
      renderLink={({ href, children, ...rest }) => (
        <Link href={href} {...rest}>
          {children}
        </Link>
      )}
      {...(sizes &&
        query &&
        pageSize !== undefined && {
          start: <PageSizeSelect query={query} sizes={sizes} value={pageSize} />,
        })}
    />
  );
}

/**
 * Vederile paginii Stoc ca tab-uri (docs/17 §3): «Toate variantele» / «Stoc mic (N)». Fiecare vedere are adresa ei, deci sunt
 * legături (nu taburi ARIA cu panouri), cu `aria-current` pe cea activă; păstrează căutarea și filtrele de tip și stare, dar nu pagina.
 * «Stoc mic» e filtrul existent «Doar stoc mic», pornit din adresă (`?filtru=stoc-mic`), nu o pagină separată.
 */
export function ViewSwitch({
  query,
  lowStockTotal,
}: {
  query: StockUrlQuery;
  lowStockTotal: number;
}) {
  const v = m.lowStock;
  const active = query.lowStockOnly === true ? "low" : "all";
  // comutatorul scoate motivul: «Stoc mic» le arată pe toate, «Toate variantele» iese din vedere
  const base: StockUrlQuery = { ...query };
  delete base.reason;
  const items = [
    { id: "all", label: v.all, href: stockHref({ ...base, lowStockOnly: false, page: 1 }) },
    {
      id: "low",
      label: v.low(lowStockTotal),
      href: stockHref({ ...base, lowStockOnly: true, page: 1 }),
    },
  ] as const;
  return (
    <nav aria-label={v.switchLabel} className={TAB_LIST_CLASS} data-view-switch>
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          data-view={item.id}
          aria-current={active === item.id ? "page" : undefined}
          className={tabClass(active === item.id)}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Câte variante sunt la «Stoc mic», pe motiv (din tot ce a găsit căutarea, nu doar de pe pagină). Fiecare card e o LEGĂTURĂ care
 * filtrează vederea pe acel motiv (`?motiv=…`); cardul activ poartă `aria-current`, iar un clic în plus pe el le arată din nou pe
 * toate. Aceleași legături sunt folosite și de cardurile din Panou.
 */
export function LowStockSummary({
  counts,
  query,
}: {
  counts: LowStockCounts;
  query: StockUrlQuery;
}) {
  const v = m.lowStock;
  const { reason: active, ...base } = query;
  const items = [
    { reason: "out_of_stock", count: counts.outOfStock },
    { reason: "remainder_only", count: counts.remainderOnly },
    { reason: "below_threshold", count: counts.belowThreshold },
  ] as const;
  return (
    <div className="flex flex-col gap-2">
      <dl
        aria-label={v.summaryLabel}
        data-low-stock-summary
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {items.map((item) => {
          const selected = active === item.reason;
          const href = selected
            ? stockHref({ ...base, lowStockOnly: true, page: 1 })
            : stockHref({ ...base, lowStockOnly: true, reason: item.reason, page: 1 });
          return (
            <div
              key={item.reason}
              data-count={item.reason}
              className={cn(
                "relative flex flex-col gap-1 rounded-lg border p-4 transition-colors duration-(--motion) hover:bg-surface-hover",
                selected ? "border-ink bg-surface-hover" : "border-line-subtle",
              )}
            >
              <dt className="text-label text-ink-secondary">
                <Link
                  href={href}
                  aria-current={selected ? "page" : undefined}
                  data-reason-filter={item.reason}
                  className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-brand"
                >
                  {v.summary[item.reason]}
                </Link>
              </dt>
              <dd className="text-kpi tabular-nums">{item.count}</dd>
            </div>
          );
        })}
      </dl>
      <p className="text-label text-ink-secondary">{v.filterHint}</p>
    </div>
  );
}
