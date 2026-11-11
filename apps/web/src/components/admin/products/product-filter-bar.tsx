"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().admin.products.filters;

const PANEL_ID = "product-filter-panel";

/**
 * Bara de filtre a listei de produse (docs/17 §4.1). De la `md` în sus: câmpul de căutare cu «Caută», apoi toate selectoarele,
 * ca până acum. Pe telefon selectoarele stau în spatele butonului «Filtre (N)» (`aria-expanded`, N = filtrele active din panou),
 * iar căutarea, «Caută» și etichetele active rămân pe ecran. Selectoarele rămân în formular și când panoul e închis (se trimit
 * oricum), deci o căutare nu pierde filtrele alese.
 */
export function ProductFilterBar({
  count,
  search,
  submit,
  reset,
  children,
}: {
  /** Câte filtre din panou sunt active (căutarea nu se numără: e mereu vizibilă). */
  count: number;
  /** Eticheta și câmpul de căutare. */
  search: ReactNode;
  /** Butonul «Caută». */
  submit: ReactNode;
  /** «Resetează filtrele» (doar cu filtre active). */
  reset?: ReactNode;
  /** Selectoarele panoului. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 basis-full flex-col gap-1.5 md:basis-0">{search}</div>
        <div className="flex flex-wrap gap-2">
          {submit}
          <Button
            type="button"
            variant="outline"
            aria-expanded={open}
            aria-controls={PANEL_ID}
            onClick={() => setOpen((current) => !current)}
            className="md:hidden"
          >
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            {m.toggle(count)}
          </Button>
          {reset}
        </div>
      </div>
      <div
        id={PANEL_ID}
        className={
          open
            ? "flex flex-wrap items-end gap-3"
            : "hidden md:flex md:flex-wrap md:items-end md:gap-3"
        }
      >
        {children}
      </div>
    </div>
  );
}
