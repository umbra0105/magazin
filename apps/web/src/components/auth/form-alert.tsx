"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@ecom/ui";

/**
 * Mesajul la nivel de formular (eroare de la server sau confirmare). `role="alert"` îl anunță
 * cititoarele de ecran, iar focusul se mută pe el când apare, ca să nu rămână ascuns sub tastatura
 * de pe telefon. Nu e o țintă de tastatură (tabIndex -1), deci nu desenează niciun inel de focus (nici la focusul programatic de la încărcarea paginii, care altfel ar fi `:focus-visible`); inelul rămâne pe câmpuri și butoane.
 */
export function FormAlert({
  tone,
  children,
  focusOnShow = true,
}: {
  tone: "error" | "success";
  children: ReactNode;
  focusOnShow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnShow) ref.current?.focus();
  }, [focusOnShow, children]);
  return (
    <div
      ref={ref}
      role={tone === "error" ? "alert" : "status"}
      tabIndex={-1}
      className={cn(
        "rounded-lg px-3 py-2 text-body focus:outline-none",
        tone === "error"
          ? "bg-tone-problem-bg text-tone-problem-fg"
          : "bg-tone-success-bg text-tone-success-fg",
      )}
    >
      {children}
    </div>
  );
}
