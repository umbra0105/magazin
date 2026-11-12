import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "../lib/cn";

/**
 * Butoanele din docs/17 §3: principal (`default`, neutru: nu urmează culoarea magazinului), secundar (`outline`), terț
 * (`ghost`), pericol (`destructive`: ca secundarul, cu text în tonul Problemă). Doar nume semantice de tokeni; înălțimea vine
 * din `--control-h` (44 px pe telefon, 36 px de la `md` în sus în admin), textul din `--button-text` (14 px în admin, la toate
 * lățimile: doar câmpurile de formular au 16 px pe telefon; 16 px pe paginile publice) sau `text-body` la mărimea compactă, iar inelul
 * de focus din `--brand`, mereu vizibil la tastatură.
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors duration-(--motion) " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page " +
    "disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "bg-action text-action-fg hover:bg-action-hover active:bg-action-pressed",
        outline:
          "border border-line-control bg-surface-page text-ink hover:bg-surface-hover active:bg-surface-hover",
        ghost: "text-ink hover:bg-surface-hover active:bg-surface-hover",
        destructive:
          "border border-line-control bg-surface-page text-tone-problem-fg hover:bg-tone-problem-bg active:bg-tone-problem-bg",
        link: "h-auto px-0 text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-(--control-h) px-4 text-(length:--button-text)",
        sm: "h-(--control-h-compact) px-3 text-body",
        /**
         * Doar pictogramă: pătrat cât înălțimea compactă (44 px pe telefon, 32 px de la `md`), dar de 44 px pe ORICE ecran tactil
         * (`pointer: coarse`, inclusiv tablete); cere `aria-label` și `title`. Cu `variant="ghost"` e butonul-pictogramă terț din
         * docs/17 §3: fără bordură și fără fundal în repaus, fundal la cursor, inel de focus.
         */
        icon: "size-(--control-h-compact) px-0 text-body pointer-coarse:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ className, variant, size, type = "button", ref, ...props }: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
