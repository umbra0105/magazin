import Link from "next/link";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.breadcrumbs;

export interface Crumb {
  name: string;
  href: string;
}

/**
 * Firimiturile paginii: o listă de legături reale (în HTML-ul de pe server); ultimul element e pagina curentă, fără legătură.
 * JSON-LD-ul `BreadcrumbList` se construiește din aceeași listă (vezi `lib/structured-data`).
 */
export function Breadcrumbs({ items, current }: { items: readonly Crumb[]; current: string }) {
  return (
    <nav aria-label={m.label} className="text-sm text-ink-secondary">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {items.map((item) => (
          <li key={item.href} className="flex items-center gap-2">
            <Link
              href={item.href}
              className="rounded-sm hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {item.name}
            </Link>
            <span aria-hidden="true">/</span>
          </li>
        ))}
        <li aria-current="page" className="text-ink">
          {current}
        </li>
      </ol>
    </nav>
  );
}
