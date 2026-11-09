"use client";

import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Titlul panoului (de obicei identificatorul: numele produsului, numărul comenzii). */
  title: string;
  /** Eticheta săgeții de înapoi (obligatorie, pentru cititoare de ecran). */
  closeLabel: string;
  /** Pastilele de stare din antet, lângă titlu. */
  status?: ReactNode;
  /** Acțiunile din antet (butoane secundare, meniu). */
  actions?: ReactNode;
  /** Acțiunile principale, fixate jos când conținutul derulează. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Panoul lateral de detalii (docs/17 §3): vine din dreapta, 560 px pe desktop (`--drawer-w`), ecran întreg pe telefon, cu
 * `shadow-drawer` și fundal `--scrim`. Antet cu săgeată înapoi, titlu, pastile de stare și acțiuni; secțiunile din interior
 * se separă cu linii `--border-subtle`; acțiunile principale rămân jos (`footer`). Pe elementul nativ `<dialog>` (modal):
 * focusul rămâne în panou, Esc îl închide și focusul se întoarce, click pe fundal îl închide. Intrarea alunecă (150 ms) și
 * dispare la `prefers-reduced-motion`.
 */
export function Drawer({
  open,
  onClose,
  title,
  closeLabel,
  status,
  actions,
  footer,
  children,
  className,
}: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (openRef.current) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "drawer-panel m-0 ml-auto h-dvh max-h-dvh w-full max-w-none overflow-hidden bg-surface-page p-0 text-ink shadow-drawer backdrop:bg-scrim md:w-(--drawer-w)",
        className,
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex items-center gap-3 border-b border-line-subtle px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex size-(--control-h) shrink-0 items-center justify-center rounded-md text-ink transition-colors duration-(--motion) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <ArrowLeft aria-hidden="true" className="size-5" />
            </button>
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-section" title={title}>
              {title}
            </h2>
            {status ? <div className="flex shrink-0 items-center gap-2">{status}</div> : null}
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </header>
          <div className="min-h-0 flex-1 divide-y divide-line-subtle overflow-y-auto">
            {children}
          </div>
          {footer ? (
            <footer className="flex items-center justify-end gap-2 border-t border-line-subtle bg-surface-page px-4 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      )}
    </dialog>
  );
}

/** O secțiune din interiorul panoului: padding uniform, linia de separare o pune `divide-y` al părintelui. */
export function DrawerSection({
  className,
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-3 px-4 py-4", className)}>
      {title ? <h3 className="text-section">{title}</h3> : null}
      {children}
    </section>
  );
}
