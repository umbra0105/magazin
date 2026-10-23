"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { cn } from "@ecom/ui";
import { activeTabId, tabHref, type AdminNavIcon, type AdminNavTab } from "@/lib/admin-nav";

export interface AdminTabBarItem extends Pick<AdminNavTab, "id" | "href" | "exact" | "keepParams"> {
  label: string;
}

/**
 * Bara de taburi a unui grup din meniu (ex. Produse). Sunt LEGĂTURI de navigare, nu taburi ARIA care ascund
 * conținut: fiecare ecran e o pagină proprie, iar tabul activ poartă `aria-current="page"`. Pe telefon bara
 * se derulează orizontal în interiorul ei (pagina nu se derulează). Tabul activ se deduce din adresă; la schimbarea
 * tabului se păstrează doar parametrii pe care ambele ecrane îi înțeleg (căutarea), restul se resetează.
 */
export function AdminTabBar({ items, label }: { items: AdminTabBarItem[]; label: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeId: AdminNavIcon | undefined = activeTabId(pathname, items);
  const current = items.find((item) => item.id === activeId);
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // pe telefon, tabul activ (ex. Stoc, ultimul) trebuie să fie în câmpul vizual al barei
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <nav aria-label={label} className="-mx-1 mb-4 overflow-x-auto border-b border-border px-1">
      <ul className="flex min-w-max gap-1">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <Link
                ref={active ? activeRef : undefined}
                href={active ? item.href : tabHref(item, current, searchParams)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  active
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
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
