"use client";

import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@ecom/ui";
import { getMessages } from "@/messages";
import { Breadcrumbs } from "./breadcrumbs";
import { SidebarNav, type SidebarNavItem } from "./sidebar-nav";
import { UserMenu } from "./user-menu";

const m = getMessages().admin;

/**
 * Cadrul zonei de admin: link „Sari la conținut”, sidebar (sertar pe telefon), topbar cu
 * firimituri și meniul utilizatorului, conținutul principal. Navigabil de la tastatură: ordinea de
 * tab e skip-link → sidebar → topbar → conținut; Escape închide sertarul și întoarce focusul.
 */
export function AdminShell({
  storeName,
  email,
  navItems,
  children,
}: {
  storeName: string;
  email: string;
  navItems: SidebarNavItem[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // Sertarul se închide la navigare.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className={
          "sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md " +
          "focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        }
      >
        {m.skipToContent}
      </a>

      {open ? (
        <button
          type="button"
          aria-label={m.closeMenu}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/40 lg:hidden"
        />
      ) : null}

      <aside
        id="admin-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col gap-4 overflow-y-auto border-r border-border bg-background p-3 " +
            "transition-transform lg:static lg:z-auto lg:translate-x-0",
          // Închis pe telefon: ieșit din ecran ȘI scos din ordinea de tab (invisible).
          open ? "translate-x-0" : "max-lg:invisible max-lg:-translate-x-full",
        )}
      >
        <div className="flex h-11 items-center justify-between px-1">
          <span className="truncate text-base font-semibold">{storeName}</span>
          <button
            type="button"
            aria-label={m.closeMenu}
            onClick={() => {
              setOpen(false);
              menuButton.current?.focus();
            }}
            className="flex size-11 items-center justify-center rounded-md hover:bg-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <SidebarNav items={navItems} label={m.sidebarLabel} />
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background px-3">
          <button
            ref={menuButton}
            type="button"
            aria-label={m.openMenu}
            aria-controls="admin-sidebar"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden"
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <Breadcrumbs />
          </div>
          <UserMenu email={email} />
        </header>
        <main id="main-content" tabIndex={-1} className="p-4 focus-visible:outline-none lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
