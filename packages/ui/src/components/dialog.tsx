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
  className?: string;
}

/**
 * Dialog modal pe elementul nativ `<dialog>`: captura focusului, Escape și restaurarea focusului
 * vin de la browser. Click pe fundal îl închide. Pe telefon ocupă lățimea ecranului.
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
        // click pe fundal (elementul <dialog> în sine, nu conținutul)
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto rounded-lg border border-border " +
          "bg-background p-0 text-foreground shadow-lg backdrop:bg-foreground/40",
        className,
      )}
    >
      {open && (
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-lg font-semibold leading-tight">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="text-sm text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-border/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
