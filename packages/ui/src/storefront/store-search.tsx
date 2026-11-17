import { Search } from "lucide-react";
import { cn } from "../lib/cn";

export interface StoreSearchProps {
  /** Eticheta câmpului (vizibilă cititoarelor de ecran). */
  label: string;
  placeholder: string;
  /** Adresa de căutare (Faza 7: `/cautare`); metoda GET, funcționează fără JavaScript. */
  action?: string;
  name?: string;
  /** Până la faza lui, câmpul e dezactivat, nu ascuns: structura se vede, funcția nu se simulează. */
  disabled?: boolean;
  /** Explicația afișată (title) cât timp e dezactivat. */
  disabledHint?: string;
  className?: string;
}

export const STORE_SEARCH_FIELD =
  "h-(--sf-control-h) w-full rounded-full border border-line-input bg-surface-page pl-12 pr-4 text-(length:--control-text) text-ink " +
  "placeholder:text-ink-placeholder transition-colors duration-(--motion) " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page " +
  "disabled:cursor-not-allowed disabled:bg-card disabled:text-ink-disabled";

/** Câmpul de căutare din header: centrat, rotund, cu pictogramă. Formular GET real (`role="search"`). */
export function StoreSearch({
  label,
  placeholder,
  action = "/cautare",
  name = "q",
  disabled = false,
  disabledHint,
  className,
}: StoreSearchProps) {
  return (
    <form
      role="search"
      action={action}
      method="get"
      noValidate
      aria-label={label}
      className={cn("relative", className)}
      title={disabled ? disabledHint : undefined}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-secondary"
      />
      <input
        type="search"
        name={name}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        className={STORE_SEARCH_FIELD}
      />
    </form>
  );
}
