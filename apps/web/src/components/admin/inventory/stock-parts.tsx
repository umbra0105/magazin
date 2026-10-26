import Link from "next/link";
import type { LowStockCounts, StockOverviewQuery, WarehouseFreshness } from "@ecom/core";
import { Button, Input, Label, Select, buttonVariants, cn } from "@ecom/ui";
import { snapshotView, type Tone } from "@/lib/stock-view";
import { LOW_STOCK_FILTER, stockHref } from "@/lib/stock-url";

import { getMessages } from "@/messages";

const m = getMessages().admin.inventory;

/** Varianta de `Badge` pentru un ton (nu există un ton «atenție» în temă: textul spune oricum starea). */
export function badgeVariant(tone: Tone): "success" | "neutral" | "danger" | "info" {
  if (tone === "ok") return "success";
  if (tone === "danger") return "danger";
  if (tone === "info") return "info";
  return "neutral";
}

/** Banner-ul «stoc verificat la …». Roșu când poza e veche sau lipsește. */
export function FreshnessBanner({
  freshness,
  timeZone,
  staleHours,
}: {
  freshness: WarehouseFreshness | null;
  timeZone: string;
  staleHours: number;
}) {
  const view = snapshotView(freshness, timeZone, staleHours);
  return (
    <div
      role={view.tone === "danger" ? "alert" : "status"}
      aria-label={m.banner.label}
      data-banner={freshness?.status ?? "none"}
      data-tone={view.tone}
      className={cn(
        "rounded-md border p-3 text-sm",
        view.tone === "danger" && "border-danger bg-danger/10",
        view.tone === "ok" && "border-success/50 bg-success/10",
        view.tone === "info" && "border-border bg-border/30",
      )}
    >
      {view.text}
    </div>
  );
}

/** Filtrele listei: formular GET (funcționează fără JavaScript), fără validare nativă. */
export function StockFilters({ query }: { query: StockOverviewQuery }) {
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
      <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
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
      <label className="flex h-10 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="filtru"
          value={LOW_STOCK_FILTER}
          defaultChecked={query.lowStockOnly === true}
        />
        {f.lowOnly}
      </label>
      <div className="flex gap-2">
        <Button type="submit">{f.apply}</Button>
        <Link href="/admin/produse/stoc" className={buttonVariants({ variant: "outline" })}>
          {f.reset}
        </Link>
      </div>
    </form>
  );
}

/** Paginarea: înapoi / înainte, cu adresa păstrând filtrele. */
export function Pager({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  if (pageCount <= 1) return null;
  const p = m.pagination;
  return (
    <nav aria-label={p.label} className="flex items-center justify-between gap-3 text-sm">
      {page > 1 ? (
        <Link
          href={hrefFor(page - 1)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          rel="prev"
        >
          {p.previous}
        </Link>
      ) : (
        <span />
      )}
      <span aria-current="page">{p.page(page, pageCount)}</span>
      {page < pageCount ? (
        <Link
          href={hrefFor(page + 1)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
          rel="next"
        >
          {p.next}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/**
 * Comutatorul de vedere al paginii Stoc: «Toate variantele» / «Stoc mic (N)». Sunt legături (nu taburi ARIA), cu `aria-current`
 * pe cea activă; păstrează căutarea și filtrele de tip și stare, dar nu pagina. «Stoc mic» e filtrul existent «Doar stoc mic»,
 * pornit din adresă (`?filtru=stoc-mic`), nu o pagină separată.
 */
export function ViewSwitch({
  query,
  lowStockTotal,
}: {
  query: StockOverviewQuery;
  lowStockTotal: number;
}) {
  const v = m.lowStock;
  const active = query.lowStockOnly === true ? "low" : "all";
  // comutatorul scoate motivul: «Stoc mic» le arată pe toate, «Toate variantele» iese din vedere
  const base: StockOverviewQuery = { ...query };
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
    <nav aria-label={v.switchLabel} className="flex gap-2" data-view-switch>
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          data-view={item.id}
          aria-current={active === item.id ? "page" : undefined}
          className={cn(
            buttonVariants({ variant: active === item.id ? "default" : "outline", size: "sm" }),
          )}
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
  query: StockOverviewQuery;
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
                "relative rounded-md border p-3 hover:bg-border/30",
                selected ? "border-primary bg-border/30" : "border-border",
              )}
            >
              <dt className="text-sm text-muted-foreground">
                <Link
                  href={href}
                  aria-current={selected ? "page" : undefined}
                  data-reason-filter={item.reason}
                  className="after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary"
                >
                  {v.summary[item.reason]}
                </Link>
              </dt>
              <dd className="text-2xl font-semibold">{item.count}</dd>
            </div>
          );
        })}
      </dl>
      <p className="text-xs text-muted-foreground">{v.filterHint}</p>
    </div>
  );
}
