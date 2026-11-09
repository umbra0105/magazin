import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Pastila de stare (docs/17 §3, §2.2): rază pill, perechea fundal + text a tonului, 12 px / 500, fără bordură. Textul stării
 * se scrie mereu (nu doar culoarea); `dot` adaugă punctul plin de 6 px în culoarea textului. Tonurile: `neutral` (neachitat,
 * ciornă, inactiv), `info` (executat, în curs), `success` (achitat, în stoc), `warning` (în așteptare, stoc mic,
 * neactualizat), `danger` (= «Problemă»: rambursat, epuizat, eroare).
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-label",
  {
    variants: {
      variant: {
        neutral: "bg-tone-neutral-bg text-tone-neutral-fg",
        info: "bg-tone-info-bg text-tone-info-fg",
        success: "bg-tone-success-bg text-tone-success-fg",
        warning: "bg-tone-warning-bg text-tone-warning-fg",
        danger: "bg-tone-problem-bg text-tone-problem-fg",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Punct plin de 6 px înaintea textului, în culoarea textului. */
  dot?: boolean;
}

export function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      ) : null}
      {children}
    </span>
  );
}
