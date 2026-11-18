"use client";

import { addToCart, openDrawer, useCartState } from "./cart-store";

/**
 * «Adaugă în coș» dintr-o listă (piese de schimb): adaugă cantitatea minimă comandabilă a variantei unice a produsului. Serverul
 * alege cantitatea și validează pasul, stocul și plafoanele; la succes se deschide sertarul coșului, care anunță rezultatul.
 */
export function QuickAddButton({
  variantId,
  title,
  label,
  ariaLabel,
}: {
  variantId: string;
  title: string;
  label: string;
  ariaLabel: string;
}) {
  const { busy } = useCartState();
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={ariaLabel}
      data-quick-add
      onClick={async () => {
        const result = await addToCart(variantId, undefined, title);
        if (result.ok) openDrawer();
      }}
      className="inline-flex min-h-11 items-center rounded-full border border-line-control bg-surface-page px-4 text-sm font-semibold text-ink transition-colors duration-(--motion) hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
    >
      {label}
    </button>
  );
}
