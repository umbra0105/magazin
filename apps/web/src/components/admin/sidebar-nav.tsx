"use client";

import {
  BarChart3,
  Boxes,
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
import { usePathname } from "next/navigation";
import { cn } from "@ecom/ui";
import type { AdminNavIcon } from "@/lib/admin-nav";

const ICONS: Record<AdminNavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  orders: ShoppingCart,
  products: Package,
  inventory: Boxes,
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

export interface SidebarNavItem {
  id: AdminNavIcon;
  href: string;
  label: string;
}

export function SidebarNav({ items, label }: { items: SidebarNavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = ICONS[item.id];
          const active =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-md px-3 text-sm text-foreground " +
                    "hover:bg-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  active && "bg-border/60 font-semibold",
                )}
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
