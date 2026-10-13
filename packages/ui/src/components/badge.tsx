import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Etichetă de stare. Doar token-uri de temă; textul nu depinde doar de culoare (se afișează mereu). */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-border bg-border/40 text-foreground",
        success: "border-success/50 bg-success/10 text-foreground",
        danger: "border-danger/50 bg-danger/10 text-foreground",
        info: "border-primary/40 bg-primary/10 text-foreground",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
