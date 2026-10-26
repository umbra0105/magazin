"use client";

import {
  BarChart3,
  ChevronDown,
  FileText,
  Gift,
  Images,
  LayoutDashboard,
  Newspaper,
  Package,
  Percent,
  ScrollText,
  Settings,
  ShoppingCart,
  Star,
  Ticket,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@ecom/ui";
import {
  activeItemId,
  itemHref,
  pathInGroup,
  type AdminNavIcon,
  type AdminNavItem,
  type AdminNavSectionId,
} from "@/lib/admin-nav";

const ICONS: Record<AdminNavSectionId, LucideIcon> = {
  dashboard: LayoutDashboard,
  orders: ShoppingCart,
  catalog: Package,
  customers: Users,
  discounts: Percent,
  reviews: Star,
  blog: Newspaper,
  loyalty: Gift,
  vouchers: Ticket,
  content: FileText,
  media: Images,
  reports: BarChart3,
  settings: Settings,
  users: UserCog,
  audit: ScrollText,
};

/** Un sub-element al unui grup (ecranul unui grup din meniu). */
export interface SidebarNavChild extends Pick<AdminNavItem, "href" | "keepParams"> {
  id: AdminNavIcon;
  label: string;
}

export interface SidebarNavItem {
  id: AdminNavSectionId;
  /** Destinația clicului la o intrare simplă (la un grup, primul element permis; grupul în sine nu e legătură). */
  href: string;
  /** Prefixul pentru starea activă și pentru deschiderea automată a grupului. */
  basePath: string;
  label: string;
  /** Prezent = grup care se deschide și se închide, cu aceste sub-elemente (cele permise). */
  children?: SidebarNavChild[];
}

const ROW =
  "flex h-11 items-center gap-3 rounded-md px-3 text-sm text-foreground hover:bg-border/50 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/**
 * Meniul din stânga. O intrare cu `children` e un GRUP: un buton cu săgeată (`aria-expanded`) care deschide sau închide lista
 * de sub-elemente. Grupul se deschide singur pe paginile lui (adresa grupului și tot ce e sub ea), iar elementul curent e
 * evidențiat (`aria-current="page"`); închis manual pe una din paginile lui, titlul rămâne marcat activ. Logica nu știe de
 * «Catalog»: orice intrare cu `children` din `ADMIN_NAV` se desenează la fel (Comenzi, Clienți etc. vor folosi același cod).
 */
export function SidebarNav({ items, label }: { items: SidebarNavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-col gap-1">
        {items.map((item) =>
          item.children ? (
            <SidebarGroup key={item.id} item={item} children={item.children} pathname={pathname} />
          ) : (
            <SidebarLink key={item.id} item={item} pathname={pathname} />
          ),
        )}
      </ul>
    </nav>
  );
}

function SidebarLink({ item, pathname }: { item: SidebarNavItem; pathname: string }) {
  const Icon = ICONS[item.id];
  const active =
    item.basePath === "/admin"
      ? pathname === "/admin"
      : pathname === item.basePath || pathname.startsWith(`${item.basePath}/`);
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={cn(ROW, active && "bg-border/60 font-semibold")}
      >
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        <span className="truncate">{item.label}</span>
      </Link>
    </li>
  );
}

function SidebarGroup({
  item,
  children,
  pathname,
}: {
  item: SidebarNavItem;
  children: SidebarNavChild[];
  pathname: string;
}) {
  const searchParams = useSearchParams();
  const Icon = ICONS[item.id];
  const inGroup = pathInGroup(pathname, item.basePath);
  // pe paginile grupului pornește deschis (și pe server, ca să nu difere de client)
  const [open, setOpen] = useState(inGroup);
  // navigarea pe o pagină a grupului îl deschide (de exemplu din firimituri, după ce l-ai închis manual)
  useEffect(() => {
    if (pathInGroup(pathname, item.basePath)) setOpen(true);
  }, [pathname, item.basePath]);

  const activeId = activeItemId(pathname, children);
  const current = children.find((child) => child.id === activeId);
  const listId = `nav-group-${item.id}`;

  return (
    <li data-nav-group={item.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        data-active={inGroup ? "true" : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(ROW, "w-full text-left", inGroup && "font-semibold")}
      >
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {/* `hidden` scoate lista din ordinea de tab și din arborele de accesibilitate cât e închisă */}
      <ul id={listId} hidden={!open} className="ml-5 mt-1 space-y-1 border-l border-border pl-2">
        {children.map((child) => {
          const active = child.id === activeId;
          return (
            <li key={child.id}>
              <Link
                href={active ? child.href : itemHref(child, current, searchParams)}
                aria-current={active ? "page" : undefined}
                className={cn(ROW, "h-11 gap-0", active && "bg-border/60 font-semibold")}
              >
                <span className="truncate">{child.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
