import type { ReactNode } from "react";
import { Label } from "@ecom/ui";

/** Id-urile elementelor asociate câmpului, ca eticheta, indiciul și eroarea să fie legate prin ARIA. */
export function fieldIds(id: string) {
  return { hint: `${id}-hint`, error: `${id}-error` };
}

/** Valoarea `aria-describedby` a controlului: indiciul și/sau eroarea, dacă există. */
export function describedBy(id: string, state: { hint?: boolean; error?: boolean }) {
  const ids = fieldIds(id);
  const parts = [state.hint ? ids.hint : "", state.error ? ids.error : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function AuthField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  const ids = fieldIds(id);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? (
        <p id={ids.hint} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.error} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
