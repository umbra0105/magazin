"use client";

import { ShoppingBag, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import { cn, storeButtonVariants } from "@ecom/ui";
import { getMessages } from "@/messages";
import { CartLive, CartPanel } from "./cart-panel";
import { closeDrawer, loadCartCount, openDrawer, useCartState } from "./cart-store";

const m = getMessages().storefront.cart;

/**
 * Coșul din header: butonul cu insigna numărului de linii și sertarul (dialog nativ modal, din dreapta: focusul rămâne în panou,
 * Esc îl închide și focusul se întoarce la buton). Fără JavaScript butonul e o legătură către `/cos`. Pe `/cos` sertarul nu se
 * deschide (pagina e deja coșul). Conținutul e `CartPanel`, același ca pe pagină.
 */
export function HeaderCartButton() {
  const onCartPage = usePathname() === "/cos";
  const { count, drawerOpen } = useCartState();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openRef = useRef(drawerOpen);
  openRef.current = drawerOpen;
  const titleId = useId();

  useEffect(() => {
    void loadCartCount();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) dialog.showModal();
    if (!drawerOpen && dialog.open) dialog.close();
  }, [drawerOpen]);

  const lines = count ?? 0;
  return (
    <>
      <Link
        href="/cos"
        aria-label={m.openLabel(lines)}
        data-cart-button
        onClick={(event) => {
          if (onCartPage || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          openDrawer();
        }}
        className={cn(storeButtonVariants({ variant: "ghost", size: "icon" }), "relative")}
      >
        <ShoppingBag aria-hidden="true" className="size-6" />
        {lines > 0 ? (
          <span
            aria-hidden="true"
            data-cart-badge
            className="absolute -right-0.5 -top-0.5 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-action px-1 text-xs font-semibold tabular-nums text-action-fg"
          >
            {lines}
          </span>
        ) : null}
      </Link>
      <dialog
        ref={dialogRef}
        data-side="right"
        data-cart-drawer
        aria-labelledby={titleId}
        onClose={() => {
          if (openRef.current) closeDrawer();
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current) closeDrawer();
        }}
        className="sheet-panel m-0 ml-auto h-dvh max-h-dvh w-full max-w-full overflow-hidden bg-surface-page p-0 text-ink shadow-drawer backdrop:bg-scrim sm:max-w-md"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-gutter py-3">
            <p id={titleId} className="text-lg font-semibold">
              {m.drawerLabel}
            </p>
            <button
              type="button"
              onClick={closeDrawer}
              aria-label={m.close}
              className="inline-flex size-(--sf-control-h) items-center justify-center rounded-full text-ink transition-colors duration-(--motion) hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <X aria-hidden="true" className="size-6" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {drawerOpen ? <CartPanel variant="drawer" /> : null}
          </div>
        </div>
      </dialog>
      <CartLive />
    </>
  );
}
