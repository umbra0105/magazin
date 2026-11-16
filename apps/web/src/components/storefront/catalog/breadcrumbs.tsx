import Link from "next/link";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.breadcrumbs;

export interface Crumb {
  name: string;
  href: string;
}

/**
 * Firimiturile paginii: o listă de legături reale (în HTML-ul de pe server); ultimul element e pagina curentă, fără legătură.
 * JSON-LD-ul `BreadcrumbList` se construiește din aceeași listă (vezi `lib/structured-data`). Pe telefon rămân doar părintele
 * direct și pagina curentă, pe UN singur rând: numele care nu încap se trunchiază cu «…» (pagina curentă primește restul
 * locului). De la `sm` apare tot drumul, cu împachetare pe rânduri.
 */
export function Breadcrumbs({ items, current }: { items: readonly Crumb[]; current: string }) {
  return (
    <nav aria-label={m.label} className="text-sm text-ink-secondary">
      <ol className="flex flex-nowrap items-center gap-x-2 sm:flex-wrap sm:gap-y-1">
        {items.map((item, index) => (
          <li
            key={item.href}
            className={`min-w-0 items-center gap-2 ${index === items.length - 1 ? "flex max-w-1/2 shrink sm:max-w-none" : "hidden sm:flex"}`}
          >
            <Link
              href={item.href}
              className="min-w-0 truncate rounded-sm hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:overflow-visible sm:whitespace-normal"
            >
              {item.name}
            </Link>
            <span aria-hidden="true" className="shrink-0">
              /
            </span>
          </li>
        ))}
        <li
          aria-current="page"
          className="min-w-0 flex-1 truncate text-ink sm:flex-none sm:overflow-visible sm:whitespace-normal"
        >
          {current}
        </li>
      </ol>
    </nav>
  );
}
