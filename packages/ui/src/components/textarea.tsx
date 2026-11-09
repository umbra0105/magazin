import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, rows = 3, ref, ...props }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        "flex w-full rounded-md border border-line-input bg-surface-page px-3 py-2 text-(length:--control-text) text-ink " +
          "placeholder:text-ink-placeholder transition-colors duration-(--motion) " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page " +
          "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-disabled aria-[invalid=true]:border-tone-problem-fg",
        className,
      )}
      {...props}
    />
  );
}
