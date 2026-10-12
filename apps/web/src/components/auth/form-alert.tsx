"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@ecom/ui";

/**
 * Mesajul la nivel de formular (eroare de la server sau confirmare). `role="alert"` îl anunță
 * cititoarele de ecran, iar focusul se mută pe el când apare, ca să nu rămână ascuns sub tastatura
 * de pe telefon.
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
        "rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        tone === "error" ? "border-danger text-danger" : "border-success text-foreground",
      )}
    >
      {children}
    </div>
  );
}
