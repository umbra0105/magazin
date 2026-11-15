"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Container, cn } from "@ecom/ui";

export interface MegaMenuItem {
  id: string;
  name: string;
  href: string;
  /** «Tot din <categorie>»: textul vine gata făcut de server (funcțiile din mesaje nu trec de la server la client). */
  seeAllLabel: string;
  children: {
    id: string;
    name: string;
    href: string;
    children: { id: string; name: string; href: string }[];
  }[];
}

export interface MegaMenuProps {
  label: string;
  allLabel: string;
  allHref: string;
  items: MegaMenuItem[];
  className?: string;
  /** Doar pentru galeria de design și teste: pornește cu panoul deschis. */
  initiallyOpen?: boolean;
}

const LINK =
  "rounded-sm outline-none transition-colors duration-(--motion) focus-visible:ring-2 focus-visible:ring-brand";

/**
 * Mega menu-ul de pe desktop (docs/21 §3.3): lista categoriilor în stânga, subcategoriile categoriei active în dreapta. TOATE
 * linkurile sunt `<a href>` în HTML-ul serverului (panourile inactive sunt doar ascunse), deci crawlerele le văd fără JavaScript.
 * Se deschide la cursor sau la click pe buton; Esc, click în afară sau ieșirea focusului îl închid. Butonul are `aria-expanded`.
 */
export function MegaMenu({
  label,
  allLabel,
  allHref,
  items,
  className,
  initiallyOpen = false,
}: MegaMenuProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // cursorul a deschis meniul: primul click pe buton îl lasă deschis (altfel «hover + click» l-ar închide imediat)
  const openedByHover = useRef(false);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn("flex h-full items-center", className)}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        if (!open) openedByHover.current = true;
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        openedByHover.current = false;
        setOpen(false);
      }}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (openedByHover.current) {
            openedByHover.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
        className={cn(
          LINK,
          "inline-flex h-(--sf-control-h) items-center gap-1.5 rounded-button px-4 font-semibold hover:bg-card",
        )}
      >
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 transition-transform duration-(--motion)", open && "rotate-180")}
        />
      </button>
      <div
        id={panelId}
        data-open={open}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className="absolute inset-x-0 top-full hidden border-t border-line-subtle bg-surface-page shadow-popover data-[open=true]:block"
      >
        <Container className="grid grid-cols-4 gap-x-10 py-8">
          <ul className="col-span-1 flex flex-col gap-1">
            {items.map((item, index) => (
              <li key={item.id}>
                <a
                  href={item.href}
                  onPointerEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  data-active={active === index}
                  className={cn(
                    LINK,
                    "flex items-center justify-between gap-2 rounded-card px-4 py-3 font-medium hover:bg-card data-[active=true]:bg-card",
                  )}
                >
                  {item.name}
                  {item.children.length > 0 ? (
                    <ChevronRight aria-hidden="true" className="size-4 text-ink-secondary" />
                  ) : null}
                </a>
              </li>
            ))}
            <li className="mt-2 border-t border-line-subtle pt-3">
              <a
                href={allHref}
                className={cn(LINK, "block px-4 py-2 font-semibold text-link hover:underline")}
              >
                {allLabel}
              </a>
            </li>
          </ul>
          <div className="col-span-3">
            {items.map((item, index) => (
              <div key={item.id} hidden={active !== index}>
                <a
                  href={item.href}
                  className={cn(LINK, "heading-display text-subhead hover:underline")}
                >
                  {item.seeAllLabel}
                </a>
                <ul className="mt-6 grid grid-cols-3 gap-x-8 gap-y-6">
                  {item.children.map((child) => (
                    <li key={child.id}>
                      <a href={child.href} className={cn(LINK, "font-semibold hover:underline")}>
                        {child.name}
                      </a>
                      {child.children.length > 0 ? (
                        <ul className="mt-2 flex flex-col gap-1.5">
                          {child.children.map((grand) => (
                            <li key={grand.id}>
                              <a
                                href={grand.href}
                                className={cn(
                                  LINK,
                                  "text-sm text-ink-secondary hover:text-ink hover:underline",
                                )}
                              >
                                {grand.name}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </div>
    </div>
  );
}
