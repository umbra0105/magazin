import type { ReactNode } from "react";
import { cn } from "@ecom/ui";

/** Stilul câmpurilor din checkout: aceleași valori ca restul vitrinei (înălțime = ținta tactilă, formă din preset). */
export const FIELD =
  "h-(--sf-control-h) w-full min-w-0 max-w-full rounded-full border border-line-input bg-surface-page px-5 text-(length:--control-text) text-ink " +
  "placeholder:text-ink-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page disabled:opacity-60 aria-[invalid=true]:border-tone-problem-fg";

export const TEXTAREA =
  "min-h-24 w-full rounded-card border border-line-input bg-surface-page px-5 py-3 text-(length:--control-text) text-ink " +
  "placeholder:text-ink-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page";

/** Un câmp cu etichetă vizibilă, text-ajutor și eroare legate prin `aria-describedby`. */
export function Field({
  id,
  label,
  help,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | undefined;
  className?: string;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {help ? (
        <p id={helpId} className="text-sm text-ink-secondary">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-tone-problem-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
