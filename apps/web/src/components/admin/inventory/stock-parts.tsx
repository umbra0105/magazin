import Link from "next/link";
import type { StockOverviewQuery, WarehouseFreshness } from "@ecom/core";
import { Button, Input, Label, Select, buttonVariants, cn } from "@ecom/ui";
import { snapshotView, type Tone } from "@/lib/stock-view";
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

/** Adresa listei cu interogarea curentă și, eventual, alte valori (pagina). */
export function stockHref(query: StockOverviewQuery, overrides: { page?: number } = {}): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.kind) params.set("tip", query.kind);
  if (query.state) params.set("stare", query.state);
  if (query.lowStockOnly) params.set("mic", "1");
  const page = overrides.page ?? query.page;
  if (page && page > 1) params.set("pagina", String(page));
  const text = params.toString();
  return text ? `/admin/produse/stoc?${text}` : "/admin/produse/stoc";
}

/** Filtrele listei: formular GET (funcționează fără JavaScript), fără validare nativă. */
export function StockFilters({ query }: { query: StockOverviewQuery }) {
  const f = m.filters;
  return (
    <form
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
        <input type="checkbox" name="mic" value="1" defaultChecked={query.lowStockOnly === true} />
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
