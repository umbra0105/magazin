import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

/**
 * Câmp de formular (docs/17 §3): bordură `--border-input` (3:1), rază 8 px, text-model `--text-placeholder`. Înălțimea și
 * mărimea textului vin din `--control-h` / `--control-text`: pe telefon 44 px și 16 px (sub 16 px, iOS Safari mărește pagina
 * la focus), de la `md` în sus 36 px și 14 px. Starea de eroare se citește din `aria-invalid`, ca stilul să urmeze semantica.
 */
export function Input({ className, type = "text", ref, ...props }: InputProps) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-(--control-h) w-full rounded-md border border-line-input bg-surface-page px-3 text-(length:--control-text) text-ink " +
          "placeholder:text-ink-placeholder transition-colors duration-(--motion) " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page " +
          "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-disabled aria-[invalid=true]:border-tone-problem-fg",
        className,
      )}
      {...props}
    />
  );
}
