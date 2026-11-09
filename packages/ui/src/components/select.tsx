import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>;
}

/** `select` nativ (tastatură și telefon gratis), cu același aspect ca `Input`; textul de 16 px pe telefon contra zoom-ului iOS. */
export function Select({ className, ref, ...props }: SelectProps) {
  return (
    <select
      ref={ref}
      className={cn(
        "flex h-(--control-h) w-full rounded-md border border-line-input bg-surface-page px-3 text-(length:--control-text) text-ink " +
          "transition-colors duration-(--motion) " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page " +
          "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-disabled aria-[invalid=true]:border-tone-problem-fg",
        className,
      )}
      {...props}
    />
  );
}
