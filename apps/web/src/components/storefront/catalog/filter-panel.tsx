import Link from "next/link";
import type { ListingFacets } from "@ecom/core";
import { StoreButton } from "@ecom/ui";
import { getMessages } from "@/messages";
import { FilterForm } from "./filter-form";
import { RangeFilter } from "./range-filter";

const m = getMessages().storefront.catalog.filters;

const CHECK = "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm text-sm";

/**
 * Panoul de filtre (docs/21 §3.4, regulile Baymard 1–8): selecție multiplă pe mărci, interval cu câmpuri și glisor pe atributele
 * numerice, listă de opțiuni pe atributele de tip listă; lângă fiecare opțiune, câte produse ar rămâne. Un formular GET obișnuit:
 * fără JavaScript se aplică cu butonul, cu JavaScript casetele și glisoarele se aplică singure. Parametrii care nu sunt filtre
 * (sortarea, căutarea) se păstrează prin câmpuri ascunse; pagina revine la prima.
 */
export function FilterPanel({
  action,
  facets,
  hidden,
  clearHref,
  hasActive,
  locale,
  framed = false,
}: {
  action: string;
  facets: ListingFacets;
  hidden: { name: string; value: string }[];
  clearHref: string;
  hasActive: boolean;
  /** Limba magazinului: numerele din intervale se scriu cu virgulă zecimală. */
  locale: string;
  /** Panou propriu (pe calculator: card cu titlu); în sertar, fără cadru dublu. */
  framed?: boolean;
}) {
  const showBrands = facets.brands.length > 1 || facets.brands.some((b) => b.selected);
  return (
    <FilterForm
      action={action}
      className={framed ? "flex flex-col gap-6 rounded-card bg-card p-6" : "flex flex-col gap-6"}
    >
      {framed ? <h2 className="text-lg font-semibold">{m.title}</h2> : null}
      {hidden.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}
      {showBrands ? (
        <div
          role="group"
          aria-label={m.brand}
          className="flex flex-col gap-1 border-t border-line-subtle pt-6 first:border-t-0 first:pt-0"
        >
          <p aria-hidden="true" className="mb-1 text-sm font-semibold">
            {m.brand}
          </p>
          {facets.brands.map((brand) => (
            <label key={brand.slug} className={CHECK}>
              <input
                type="checkbox"
                name="marca"
                value={brand.slug}
                defaultChecked={brand.selected}
                className="size-5 shrink-0 accent-brand"
              />
              <span className="min-w-0 flex-1">{brand.name}</span>
              <span className="text-ink-secondary">({brand.count})</span>
            </label>
          ))}
        </div>
      ) : null}
      {/* un interval cu o singură valoare în listă (minim = maxim) nu filtrează nimic: nu se arată, decât dacă e deja ales */}
      {facets.ranges
        .filter((range) => range.min !== range.max || range.selected !== null)
        .map((range) => (
          <div
            key={range.code}
            className="border-t border-line-subtle pt-6 first:border-t-0 first:pt-0"
          >
            <RangeFilter
              code={range.code}
              name={range.name}
              unit={range.unit}
              min={range.min}
              max={range.max}
              selectedMin={range.selected?.min ?? null}
              selectedMax={range.selected?.max ?? null}
              count={range.count}
              locale={locale}
            />
          </div>
        ))}
      {facets.options.map((group) => (
        <div
          key={group.code}
          role="group"
          aria-label={group.name}
          className="flex flex-col gap-1 border-t border-line-subtle pt-6 first:border-t-0 first:pt-0"
        >
          <p aria-hidden="true" className="mb-1 text-sm font-semibold">
            {group.name}
          </p>
          {group.options.map((option) => (
            <label key={option.id} className={CHECK}>
              <input
                type="checkbox"
                name={`f_${group.code}`}
                value={option.id}
                defaultChecked={option.selected}
                className="size-5 shrink-0 accent-brand"
              />
              <span className="min-w-0 flex-1">{option.value}</span>
              <span className="text-ink-secondary">({option.count})</span>
            </label>
          ))}
        </div>
      ))}
      <div className="flex flex-col gap-2 border-t border-line-subtle pt-6">
        <StoreButton type="submit">{m.apply}</StoreButton>
        {hasActive ? (
          <Link
            href={clearHref}
            className="inline-flex h-11 items-center justify-center rounded-full text-sm font-medium underline underline-offset-2 hover:no-underline"
          >
            {m.clear}
          </Link>
        ) : null}
      </div>
    </FilterForm>
  );
}
