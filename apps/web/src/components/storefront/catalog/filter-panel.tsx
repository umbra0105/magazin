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
}: {
  action: string;
  facets: ListingFacets;
  hidden: { name: string; value: string }[];
  clearHref: string;
  hasActive: boolean;
}) {
  const showBrands = facets.brands.length > 1 || facets.brands.some((b) => b.selected);
  return (
    <FilterForm action={action} className="flex flex-col gap-7">
      {hidden.map((field) => (
        <input key={field.name} type="hidden" name={field.name} value={field.value} />
      ))}
      {showBrands ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-semibold">{m.brand}</legend>
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
        </fieldset>
      ) : null}
      {facets.ranges.map((range) => (
        <RangeFilter
          key={range.code}
          code={range.code}
          name={range.name}
          unit={range.unit}
          min={range.min}
          max={range.max}
          selectedMin={range.selected?.min ?? null}
          selectedMax={range.selected?.max ?? null}
          count={range.count}
        />
      ))}
      {facets.options.map((group) => (
        <fieldset key={group.code} className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-semibold">{group.name}</legend>
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
        </fieldset>
      ))}
      <div className="flex flex-col gap-2">
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
