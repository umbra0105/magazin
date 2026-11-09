"use client";

import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@ecom/ui";
import {
  SIDEBAR_ATTRIBUTE,
  applySidebarChoice,
  writeSidebarChoice,
  type SidebarChoice,
} from "@/lib/sidebar-choice";
import { getMessages } from "@/messages";
import { Breadcrumbs } from "./breadcrumbs";
import { SidebarNav, type SidebarNavItem } from "./sidebar-nav";
import { UserMenu } from "./user-menu";

const m = getMessages().admin;

/** Sigla magazinului (`logoUrl` din Branding) sau, până există sau dacă nu se încarcă, inițiala numelui pe fundal neutru. */
export function StoreMark({ storeName, logoUrl }: { storeName: string; logoUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (logoUrl && failedUrl !== logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- adresa o alege magazinul din Branding (https sau cale locală, validată de Zod); nu trece prin optimizatorul de imagini
      <img
        src={logoUrl}
        alt=""
        data-store-logo
        onError={() => setFailedUrl(logoUrl)}
        className="size-8 shrink-0 rounded-lg object-contain"
      />
    );
  }
  const initial = Array.from(storeName.trim())[0]?.toUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      data-store-initial
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-action text-body font-semibold text-action-fg"
    >
      {initial}
    </span>
  );
}

/**
 * Cadrul zonei de admin: link „Sari la conținut”, sidebar (sertar pe telefon, pliabil la 64 px pe desktop), topbar cu
 * firimituri și meniul utilizatorului, conținutul principal. Navigabil de la tastatură: ordinea de
 * tab e skip-link → sidebar → topbar → conținut; Escape închide sertarul și întoarce focusul.
 */
export function AdminShell({
  storeName,
  logoUrl,
  email,
  navItems,
  children,
}: {
  storeName: string;
  logoUrl: string | null;
  email: string;
  navItems: SidebarNavItem[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  // Starea pliată o pune scriptul din <head> pe <html> înainte de primul paint; aici doar o citim ca să știe butonul.
  useEffect(() => {
    setCollapsed(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE) === "collapsed");
  }, []);

  function chooseSidebar(next: SidebarChoice) {
    setCollapsed(next === "collapsed");
    applySidebarChoice(next);
    writeSidebarChoice(next); // fără stocare, alegerea rămâne valabilă pe pagina curentă
  }

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

  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const collapseLabel = collapsed ? m.expandMenu : m.collapseMenu;

  return (
    <div className="min-h-dvh bg-surface-page text-ink lg:grid lg:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]">
      <a
        href="#main-content"
        className={
          "sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md " +
          "focus:border focus:border-line-control focus:bg-surface-page focus:px-4 focus:py-2 focus:text-body " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        }
      >
        {m.skipToContent}
      </a>

      {open ? (
        <button
          type="button"
          aria-label={m.closeMenu}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-scrim lg:hidden"
        />
      ) : null}

      <aside
        id="admin-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-(--sidebar-w) flex-col gap-4 overflow-y-auto border-r border-line-subtle bg-surface-page p-3 " +
            "transition-transform duration-(--motion) lg:static lg:z-auto lg:translate-x-0",
          // Închis pe telefon: ieșit din ecran ȘI scos din ordinea de tab (invisible).
          open ? "translate-x-0" : "max-lg:invisible max-lg:-translate-x-full",
        )}
      >
        <div className="flex h-11 items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-3">
            <StoreMark storeName={storeName} logoUrl={logoUrl} />
            <span data-sidebar-label className="truncate text-section">
              {storeName}
            </span>
          </div>
          <button
            type="button"
            aria-label={m.closeMenu}
            onClick={() => {
              setOpen(false);
              menuButton.current?.focus();
            }}
            className="flex size-(--control-h) items-center justify-center rounded-md transition-colors duration-(--motion) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <SidebarNav
          items={navItems}
          label={m.sidebarLabel}
          collapsed={collapsed}
          onExpand={() => chooseSidebar("expanded")}
        />
        <button
          type="button"
          onClick={() => chooseSidebar(collapsed ? "expanded" : "collapsed")}
          aria-label={collapseLabel}
          aria-controls="admin-sidebar"
          aria-expanded={!collapsed}
          title={collapseLabel}
          data-sidebar-toggle
          className="mt-auto hidden h-(--control-h) items-center gap-3 rounded-md px-2.5 text-body text-ink-secondary transition-colors duration-(--motion) hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:flex"
        >
          <CollapseIcon aria-hidden="true" className="size-5 shrink-0" />
          <span data-sidebar-label className="truncate">
            {collapseLabel}
          </span>
        </button>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-(--topbar-h) items-center gap-2 border-b border-line-subtle bg-surface-page px-4">
          <button
            ref={menuButton}
            type="button"
            aria-label={m.openMenu}
            aria-controls="admin-sidebar"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex size-(--control-h) shrink-0 items-center justify-center rounded-md transition-colors duration-(--motion) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
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
