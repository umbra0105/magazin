import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-tone-neutral-bg text-tone-neutral-fg",
        success: "bg-tone-success-bg text-tone-success-fg",
        warning: "bg-tone-warning-bg text-tone-warning-fg",
        problem: "bg-tone-problem-bg text-tone-problem-fg",
        info: "bg-tone-info-bg text-tone-info-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type StorePillTone = NonNullable<VariantProps<typeof pillVariants>["tone"]>;

/** Pastila de stare a vitrinei (disponibilitate, etichete): ton semantic, text mereu în culoarea de text (AA pe fundalul tonului). */
export function StorePill({
  tone,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: StorePillTone }) {
  return <span className={cn(pillVariants({ tone }), className)} {...props} />;
}
