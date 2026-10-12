import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

/**
 * Text de 16px (`text-base`): sub 16px, iOS Safari mărește pagina la focus. Starea de eroare se
 * citește din `aria-invalid`, ca stilul să urmeze semantica.
 */
export function Input({ className, type = "text", ref, ...props }: InputProps) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-11 w-full rounded-md border border-border bg-background px-3 text-base text-foreground " +
          "placeholder:text-muted-foreground " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
          "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
}
