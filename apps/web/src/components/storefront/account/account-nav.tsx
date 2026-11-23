"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@ecom/ui";

export interface AccountNavItem {
  href: string;
  label: string;
}

/**
 * Meniul contului (stânga pe calculator, rând derulabil pe telefon). Elementul curent are `aria-current="page"`; paginile unui
 * element (detaliul unei comenzi, al unui retur) țin evidențiat elementul părinte.
 */
export function AccountNav({ items, label }: { items: AccountNavItem[]; label: string }) {
  const pathname = usePathname();
  const current = items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <nav aria-label={label} data-account-nav>
      <ul className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
        {items.map((item) => {
          const active = current?.href === item.href;
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-full px-4 text-(length:--button-text) font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  active ? "bg-action text-action-fg" : "text-ink hover:bg-card",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
