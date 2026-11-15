"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface NavSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
  className?: string;
}

/**
 * Panoul de navigare de pe telefon: vine din stânga, pe tot ecranul sub 40rem (altfel o fâșie din pagină rămâne la margine) și cu pagina de sub el blocată la derulare, pe elementul nativ `<dialog>` modal (focusul rămâne în panou, Esc îl închide
 * și focusul se întoarce la buton, click pe fundal îl închide). Intrarea e o tranziție scurtă, oprită la `prefers-reduced-motion`.
 * Linkurile din interior sunt `<a href>` obișnuite: același meniu ca pe desktop, citit și fără JavaScript din HTML-ul serverului.
 */
export function NavSheet({ open, onClose, title, closeLabel, children, className }: NavSheetProps) {
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
        "sheet-panel m-0 mr-auto h-dvh max-h-dvh w-full max-w-full overflow-hidden sm:max-w-sm bg-surface-page p-0 text-ink shadow-drawer backdrop:bg-scrim",
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-gutter py-3">
          <p id={titleId} className="text-lg font-semibold">
            {title}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-flex size-(--sf-control-h) items-center justify-center rounded-full text-ink transition-colors duration-(--motion) hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X aria-hidden="true" className="size-6" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </dialog>
  );
}
