"use client";

import { ChevronDown, Menu } from "lucide-react";
import { useState } from "react";
import { NavSheet, StoreButton } from "@ecom/ui";
import type { MegaMenuItem } from "./mega-menu";

export interface MobileNavProps {
  openLabel: string;
  closeLabel: string;
  title: string;
  allLabel: string;
  allHref: string;
  items: MegaMenuItem[];
  className?: string;
  /** Doar pentru galeria de design și teste: pornește cu panoul deschis. */
  initiallyOpen?: boolean;
}

const ROW =
  "flex min-h-(--sf-control-h) items-center rounded-card px-4 font-medium transition-colors duration-(--motion) hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

/**
 * Meniul de pe telefon: butonul din header deschide un panou din stânga cu aceleași categorii ca pe desktop. Categoriile cu
 * subcategorii sunt `<details>` native (se deschid și fără JavaScript); toate linkurile sunt `<a href>` în HTML-ul serverului.
 * Un click pe orice legătură închide panoul.
 */
export function MobileNav({
  openLabel,
  closeLabel,
  title,
  allLabel,
  allHref,
  items,
  className,
  initiallyOpen = false,
}: MobileNavProps) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <StoreButton
        variant="ghost"
        size="icon"
        aria-label={openLabel}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={className}
      >
        <Menu aria-hidden="true" className="size-6" />
      </StoreButton>
      <NavSheet open={open} onClose={() => setOpen(false)} title={title} closeLabel={closeLabel}>
        <nav
          aria-label={title}
          className="px-3 py-3"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <ul className="flex flex-col gap-1">
            <li>
              <a href={allHref} className={`${ROW} font-semibold text-link`}>
                {allLabel}
              </a>
            </li>
            {items.map((item) => (
              <li key={item.id}>
                {item.children.length === 0 ? (
                  <a href={item.href} className={ROW}>
                    {item.name}
                  </a>
                ) : (
                  <details className="group">
                    <summary className={`${ROW} cursor-pointer list-none justify-between`}>
                      {item.name}
                      <ChevronDown
                        aria-hidden="true"
                        className="size-4 text-ink-secondary transition-transform duration-(--motion) group-open:rotate-180"
                      />
                    </summary>
                    <ul className="mb-2 ml-4 flex flex-col gap-0.5 border-l border-line-subtle pl-2">
                      <li>
                        <a href={item.href} className={`${ROW} text-ink-secondary`}>
                          {item.seeAllLabel}
                        </a>
                      </li>
                      {item.children.map((child) => (
                        <li key={child.id}>
                          <a href={child.href} className={ROW}>
                            {child.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </NavSheet>
    </>
  );
}
