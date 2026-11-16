import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn";

/**
 * Butoanele vitrinei (docs/21 §2.3). Forma vine din preset prin `--radius-button` (pastilă la Minimal, rotunjit la Bold,
 * aproape dreptunghiular la Editorial); culorile din tokeni semantici. Variantele `onImage` și `outlineOnImage` sunt pentru
 * hero-ul fotografic (text deschis pe strat întunecat, în orice temă). Înălțimea de 48 px (56 px la `lg`) e și ținta tactilă.
 * Un element dezactivat de faza lui (căutare, coș) primește `aria-disabled`, nu dispare.
 */
export const storeButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button font-semibold transition-colors duration-(--motion) " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page " +
    "disabled:pointer-events-none disabled:opacity-60 aria-disabled:pointer-events-none aria-disabled:opacity-60",
  {
    variants: {
      variant: {
        primary: "bg-action text-action-fg hover:bg-action-hover active:bg-action-pressed",
        secondary:
          "border border-line-control bg-surface-page text-ink hover:bg-card active:bg-card-hover",
        ghost: "text-ink hover:bg-card active:bg-card-hover",
        onImage: "bg-on-image text-image-ink hover:bg-on-image/90",
        outlineOnImage: "border border-on-image text-on-image hover:bg-on-image/15",
      },
      size: {
        md: "h-(--sf-control-h) px-6 text-(length:--button-text)",
        lg: "h-(--sf-control-h-lg) px-8 text-lg",
        /** Doar pictogramă: întotdeauna rotund, cu `aria-label`. */
        icon: "size-(--sf-control-h) rounded-full px-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface StoreButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof storeButtonVariants> {
  ref?: Ref<HTMLButtonElement>;
}

export function StoreButton({
  className,
  variant,
  size,
  type = "button",
  ref,
  ...props
}: StoreButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(storeButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
