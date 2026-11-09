"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** Eticheta butonului de închidere (obligatorie, pentru cititoare de ecran). */
  closeLabel: string;
  children: ReactNode;
  /** Lățimea maximă a dialogului (ex. `max-w-lg`); implicit `max-w-2xl`. */
  className?: string;
}

/**
 * Dialog modal pe elementul nativ `<dialog>` (docs/17 §3): captura focusului, Escape și restaurarea focusului vin de la
 * browser; fundal `--scrim`, rază 12 px, `shadow-dialog`. Click pe fundal îl închide. Elementul `<dialog>` e doar un cadru
 * transparent (pe telefon cu un chenar de 12 px în jur, ca panoul să nu atingă marginea ecranului); panoul vizibil e
 * `div`-ul dinăuntru, care și derulează când conținutul e înalt.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  closeLabel,
  children,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const titleId = useId();
  const descriptionId = useId();

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
      aria-describedby={description ? descriptionId : undefined}
      // `close` se declanșează și la închiderea programatică (open=false); doar închiderea de
      // către utilizator (Escape) trebuie raportată, altfel părintele ar reacționa de două ori.
      onClose={() => {
        if (openRef.current) onClose();
      }}
      onClick={(event) => {
        // click pe fundal (elementul <dialog> în sine, nu panoul)
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-full max-w-2xl overflow-visible bg-transparent p-3 text-ink backdrop:bg-scrim sm:p-0",
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[92dvh] flex-col gap-4 overflow-y-auto rounded-lg bg-surface-page p-4 shadow-dialog sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-section">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="text-body text-ink-secondary">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex size-(--control-h) shrink-0 items-center justify-center rounded-md text-ink transition-colors duration-(--motion) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
