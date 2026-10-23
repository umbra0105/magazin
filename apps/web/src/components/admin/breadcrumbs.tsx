"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { breadcrumbsFor } from "@/lib/admin-nav";
import { getMessages } from "@/messages";

const m = getMessages().admin;

/** Calculată în browser din `usePathname()`: layout-ul nu se re-randează la navigarea între pagini. */
export function Breadcrumbs() {
  const pathname = usePathname();
  const crumbs = breadcrumbsFor(
    pathname,
    (id) => m.nav[id],
    m.home,
    undefined,
    (section, raw, previous) => {
      // /admin/produse/stoc/<id variantă>: eticheta «Istoric», nu id-ul tehnic (secțiunea e id-ul tabului)
      if (section === "inventory") return m.inventory.history.breadcrumb;
      if (section !== "products") return null;
      // /admin/produse/import/istoric și /admin/produse/import/istoric/<id>
      if (raw === "istoric" && previous === "import") return m.productImport.history.title;
      if (previous === "istoric") return m.productImport.history.detail.breadcrumb;
      // /admin/produse/nou și /admin/produse/<id>: etichete, nu cuvântul „nou” sau id-ul tehnic
      if (raw === "import") return m.productImport.title;
      return raw === "nou" ? m.products.editor.createTitle : m.products.editor.breadcrumbEdit;
    },
  );
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={m.breadcrumbLabel} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => (
          <li key={`${index}-${crumb.label}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : null}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="truncate rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate font-medium">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
