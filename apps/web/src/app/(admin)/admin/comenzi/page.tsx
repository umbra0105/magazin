import type { Metadata } from "next";
import Link from "next/link";
import { can, countOrderViews, listAdminOrders, listSavedViews, ORDER_VIEWS } from "@ecom/core";
import { getDb } from "@ecom/db";
import { TEMPLATE_CATALOG } from "@ecom/jobs";
import {
  Button,
  EmptyState,
  Input,
  Label,
  Pagination,
  Select,
  ScrollableTabNav,
  scrollableTabClass,
  filterChipClass,
} from "@ecom/ui";
import { OrdersTable, type OrderRowDto } from "@/components/admin/orders/orders-table";
import { SavedViewsManager } from "@/components/admin/orders/saved-views";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { formatDateTime } from "@/lib/format-date";
import { formatMoney } from "@/lib/money-input";
import {
  FILTER_PARAMS,
  INSTALLATION_VALUES,
  METHOD_VALUES,
  ORDER_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
  FULFILLMENT_STATUS_VALUES,
  SORT_SLUGS,
  filterQueryString,
  parseOrderListParams,
  viewSlug,
} from "@/lib/order-list-params";
import { getSettings } from "@/lib/services";
import { getFeatureFlags } from "@/lib/services";
import { getMessages } from "@/messages";

const t = getMessages().admin.orders;

export const metadata: Metadata = { title: t.title };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * Lista comenzilor (Faza 11, macheta 1 din docs/17 §4): vederi ca tab-uri-legături (implicite și proprii), căutare, filtre cu
 * etichete eliminabile, sortare, paginare, acțiuni în masă și panou lateral. Cere `orders.read`. Fiecare interogare are `ORDER BY`
 * determinist; contactul clientului apare doar cu drept de date personale; exportul CSV trece prin funcția comună.
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const subject = await requireAdmin({ permission: "orders.read" });
  const search = await searchParams;
  const settings = getSettings();
  const regional = await settings.getGroup("regional");
  const labels = {
    statuses: t.statuses,
    paymentStatuses: t.paymentStatuses,
    fulfillmentStatuses: t.fulfillmentStatuses,
    methods: t.methods,
    deliveryKinds: { courier: t.filters.deliveryCourier, pickup: t.filters.deliveryPickup },
    installationStatuses: t.installationStatuses,
  };
  const parsed = parseOrderListParams(search, { timeZone: regional.timezone, labels });
  const pii = can(subject, "customers.read_pii") || can(subject, "orders.fulfill");
  const db = getDb();
  const installationOn = await getFeatureFlags().isEnabled("installationRequests");
  const [list, counts, saved] = await Promise.all([
    listAdminOrders(db, parsed.query, { pii }),
    countOrderViews(db),
    listSavedViews(db, subject.userId),
  ]);
  const money = (minor: number) => formatMoney(minor, regional.currency, regional.locale);
  const pageCount = Math.max(1, Math.ceil(list.total / list.pageSize));

  const current = new URLSearchParams();
  for (const name of [...FILTER_PARAMS, "pe-pagina"] as const) {
    const value = first(search[name]).trim();
    if (value !== "") current.set(name, value);
  }
  const currentFilters = filterQueryString(current);
  const href = (params: URLSearchParams) => {
    const query = params.toString();
    return query ? `/admin/comenzi?${query}` : "/admin/comenzi";
  };
  const withoutParam = (param: string, value?: string): string => {
    const next = new URLSearchParams(current);
    if (value !== undefined && next.get(param)?.includes(",")) {
      const rest = (next.get(param) ?? "").split(",").filter((part) => part !== value);
      if (rest.length > 0) next.set(param, rest.join(","));
      else next.delete(param);
    } else next.delete(param);
    return href(next);
  };
  const pageHref = (page: number) => {
    const next = new URLSearchParams(current);
    if (page > 1) next.set("pagina", String(page));
    return href(next);
  };

  const noExtraFilters = (view: string) =>
    currentFilters === (view === "toate" ? "" : `vedere=${view}`);
  const defaultViews = ORDER_VIEWS.map((view) => ({
    view,
    slug: viewSlug(view),
    label: view === "all" ? t.views.all : t.views[view](counts[view]),
  }));
  const rows: OrderRowDto[] = list.rows.map((row) => ({
    id: row.id,
    number: row.number,
    dateText: formatDateTime(row.placedAt, regional.locale, regional.timezone),
    customer: row.customerName,
    email: row.email,
    totalText: money(row.totalMinor),
    status: row.status,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    paymentMethod: row.paymentMethod,
    delivery: row.delivery,
    supplier: row.supplier,
    installationStatus: row.installationStatus,
    attention: row.attention,
    needsRefund: row.needsRefund,
  }));
  const filterCount = parsed.applied.filter((a) => a.param !== "q").length;
  const customerTemplates = TEMPLATE_CATALOG.filter(
    (x) => x.wired && x.audience === "customer",
  ).map((x) => ({
    key: x.key,
    label: x.label,
  }));
  const canWrite = can(subject, "orders.write");

  const errorText = (key: string): string | undefined => {
    const code = parsed.errors[key];
    if (!code) return undefined;
    return code === "date"
      ? t.filters.invalidDate
      : code === "range"
        ? t.filters.invalidRange
        : code === "amount"
          ? t.filters.invalidAmount
          : t.filters.invalidAmountRange;
  };

  const current25 = parsed.query.pageSize ?? 25;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={t.title}
          count={list.total}
          description={t.description}
          notes={can(subject, "orders.write") ? [] : [t.readOnly]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SavedViewsManager views={saved} currentQuery={currentFilters} />
          <form method="post" action="/api/admin/order-exports" noValidate>
            <input type="hidden" name="query" value={currentFilters} />
            <Button type="submit" variant="outline" size="sm" title={t.export.help}>
              {t.export.button}
            </Button>
          </form>
        </div>
      </div>

      <ScrollableTabNav label={t.views.nav}>
        {defaultViews.map((item) => {
          const active =
            noExtraFilters(item.slug) && (item.view === "all" ? currentFilters === "" : true);
          return (
            <Link
              key={item.view}
              href={item.view === "all" ? "/admin/comenzi" : `/admin/comenzi?vedere=${item.slug}`}
              aria-current={active ? "page" : undefined}
              className={scrollableTabClass(active)}
            >
              {item.label}
            </Link>
          );
        })}
        {saved.map((view) => {
          const active = currentFilters === view.query && view.query !== "";
          return (
            <Link
              key={view.id}
              href={view.query ? `/admin/comenzi?${view.query}` : "/admin/comenzi"}
              aria-current={active ? "page" : undefined}
              className={scrollableTabClass(active)}
              data-saved-view={view.name}
            >
              {view.name}
            </Link>
          );
        })}
      </ScrollableTabNav>

      <form
        method="get"
        action="/admin/comenzi"
        noValidate
        className="flex flex-col gap-3"
        data-order-filters
      >
        {first(search["vedere"]) !== "" && (
          <input type="hidden" name="vedere" value={first(search["vedere"])} />
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="orders-q">{t.search.label}</Label>
            <Input
              id="orders-q"
              name="q"
              type="text"
              autoComplete="off"
              placeholder={t.search.placeholder}
              defaultValue={parsed.query.q ?? ""}
            />
          </div>
          <Button type="submit">{t.search.submit}</Button>
        </div>
        <details
          className="rounded-lg bg-surface-subtle p-3"
          open={filterCount > 0 || Object.keys(parsed.errors).length > 0}
        >
          <summary className="cursor-pointer text-body font-medium">
            {t.filters.toggle(filterCount)}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FilterSelect
              id="f-stare"
              name="stare"
              label={t.filters.status}
              value={first(search["stare"])}
              options={ORDER_STATUS_VALUES.map((v) => [v, t.statuses[v] ?? v])}
              any={t.filters.deliveryAny}
            />
            <FilterSelect
              id="f-plata"
              name="plata"
              label={t.filters.payment}
              value={first(search["plata"])}
              options={PAYMENT_STATUS_VALUES.map((v) => [v, t.paymentStatuses[v] ?? v])}
              any={t.filters.deliveryAny}
            />
            <FilterSelect
              id="f-expediere"
              name="expediere"
              label={t.filters.fulfillment}
              value={first(search["expediere"])}
              options={FULFILLMENT_STATUS_VALUES.map((v) => [v, t.fulfillmentStatuses[v] ?? v])}
              any={t.filters.deliveryAny}
            />
            <FilterSelect
              id="f-metoda"
              name="metoda"
              label={t.filters.method}
              value={first(search["metoda"])}
              options={METHOD_VALUES.map((v) => [v, t.methods[v] ?? v])}
              any={t.filters.deliveryAny}
            />
            <FilterSelect
              id="f-livrare"
              name="livrare"
              label={t.filters.delivery}
              value={first(search["livrare"])}
              options={[
                ["curier", t.filters.deliveryCourier],
                ["ridicare", t.filters.deliveryPickup],
              ]}
              any={t.filters.deliveryAny}
            />
            {installationOn && (
              <FilterSelect
                id="f-instalare"
                name="instalare"
                label={t.filters.installation}
                value={first(search["instalare"])}
                options={INSTALLATION_VALUES.map((v) => [v, t.installationStatuses[v] ?? v])}
                any={t.filters.deliveryAny}
              />
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-de-la">{t.filters.from}</Label>
              <Input
                id="f-de-la"
                name="de-la"
                type="date"
                defaultValue={first(search["de-la"])}
                aria-invalid={errorText("de-la") ? true : undefined}
              />
              {errorText("de-la") && (
                <p className="text-label text-tone-problem-fg">{errorText("de-la")}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-pana-la">{t.filters.to}</Label>
              <Input
                id="f-pana-la"
                name="pana-la"
                type="date"
                defaultValue={first(search["pana-la"])}
                aria-invalid={errorText("pana-la") ? true : undefined}
              />
              {errorText("pana-la") && (
                <p className="text-label text-tone-problem-fg">{errorText("pana-la")}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-suma-min">{t.filters.minTotal}</Label>
              <Input
                id="f-suma-min"
                name="suma-min"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={first(search["suma-min"])}
                aria-invalid={errorText("suma-min") ? true : undefined}
              />
              {errorText("suma-min") && (
                <p className="text-label text-tone-problem-fg">{errorText("suma-min")}</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-suma-max">{t.filters.maxTotal}</Label>
              <Input
                id="f-suma-max"
                name="suma-max"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={first(search["suma-max"])}
                aria-invalid={errorText("suma-max") ? true : undefined}
              />
              {errorText("suma-max") && (
                <p className="text-label text-tone-problem-fg">{errorText("suma-max")}</p>
              )}
            </div>
            <FilterSelect
              id="f-sortare"
              name="sortare"
              label={t.filters.sort}
              value={first(search["sortare"])}
              options={SORT_SLUGS.map(({ id, slug }) => [slug, t.sorts[id] ?? id])}
              any={t.sorts["placed_desc"] ?? ""}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-pe-pagina">{t.filters.pageSize}</Label>
              <Select id="f-pe-pagina" name="pe-pagina" defaultValue={String(current25)}>
                {[10, 25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                name="furnizor"
                value="1"
                defaultChecked={first(search["furnizor"]) === "1"}
                className="size-4 accent-brand"
              />
              {t.filters.supplier}
            </label>
            <label className="flex items-center gap-2 text-body">
              <input
                type="checkbox"
                name="atentie"
                value="1"
                defaultChecked={first(search["atentie"]) === "1"}
                className="size-4 accent-brand"
              />
              {t.filters.attention}
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit">{t.filters.apply}</Button>
            <Link
              href="/admin/comenzi"
              className="inline-flex h-(--control-h) items-center rounded-md border border-line-control px-3 text-body hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {t.filters.reset}
            </Link>
          </div>
        </details>
      </form>

      {parsed.applied.length > 0 && (
        <ul
          className="flex flex-wrap gap-2"
          aria-label={t.filters.toggle(filterCount)}
          data-filter-chips
        >
          {parsed.applied.map((chip) => (
            <li key={`${chip.param}:${chip.value ?? ""}`}>
              <Link
                href={withoutParam(chip.param, chip.value)}
                className={filterChipClass}
                aria-label={t.filters.removeChip(chip.label)}
              >
                {chip.label} <span aria-hidden="true">×</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.rows.length === 0 ? (
        <EmptyState title={t.empty.title} description={t.empty.hint} />
      ) : (
        <OrdersTable
          rows={rows}
          caps={{
            process: canWrite,
            cancel: can(subject, "orders.cancel"),
            supplier: canWrite,
            resend: canWrite,
          }}
          resendTemplates={customerTemplates}
          locale={regional.locale}
          currency={regional.currency}
          timeZone={regional.timezone}
        />
      )}

      {list.total > 0 && (
        <Pagination
          label={t.pagination.label}
          page={list.page}
          pageCount={pageCount}
          hrefFor={pageHref}
          previousLabel={t.pagination.previous}
          nextLabel={t.pagination.next}
          pageLabel={(page) => `Pagina ${page}`}
          summary={t.pagination.summary}
          renderLink={({ children, ...props }) => (
            <Link {...props} href={props.href}>
              {children}
            </Link>
          )}
        />
      )}
    </div>
  );
}

function FilterSelect({
  id,
  name,
  label,
  value,
  options,
  any,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  any: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} name={name} defaultValue={value.split(",")[0] ?? ""}>
        <option value="">{any}</option>
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );
}
