"use client";

import { Heart } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@ecom/ui";
import { toggleWishlistAction } from "@/app/(storefront)/cont/actions";
import { getMessages } from "@/messages";

const m = getMessages().account.favorites;

interface WishlistState {
  signedIn: boolean;
  ids: Set<string>;
}

// o singură cerere pentru toate butoanele din pagină; se reîncarcă după fiecare schimbare
let pending: Promise<WishlistState | null> | null = null;
function loadState(): Promise<WishlistState | null> {
  pending ??= fetch("/api/account/wishlist-state", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = (await response.json()) as { signedIn: boolean; ids: string[] };
      return { signedIn: body.signedIn, ids: new Set(body.ids) };
    })
    .catch(() => null);
  return pending;
}

/**
 * Butonul «inimă» (Faza 14, doar cu flag-ul `wishlist` pornit; paginile îl randează doar atunci). Pentru un oaspete duce la
 * autentificare și apoi înapoi pe aceeași pagină; pentru un client autentificat salvează sau scoate varianta. Starea vine dintr-o
 * singură cerere pe pagină. `aria-pressed` spune dacă e salvat.
 */
export function WishlistButton({
  variantId,
  name,
  className,
}: {
  variantId: string;
  name: string;
  className?: string;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void loadState().then((state) => {
      if (!active || !state) return;
      setSignedIn(state.signedIn);
      setSaved(state.ids.has(variantId));
    });
    return () => {
      active = false;
    };
  }, [variantId]);

  async function toggle() {
    if (signedIn === false) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/autentificare?next=${encodeURIComponent(next)}`);
      return;
    }
    setBusy(true);
    try {
      const result = await toggleWishlistAction({ variantId, save: !saved });
      if (result.ok) {
        setSaved(result.saved);
        pending = null;
      } else if (result.code === "unauthenticated") {
        setSignedIn(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const label = saved ? m.remove : signedIn === false ? m.signInToSave : m.add;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={saved}
      aria-label={`${label}: ${name}`}
      title={label}
      data-wishlist-button
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-full bg-surface-page/90 text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60",
        className,
      )}
    >
      <Heart aria-hidden="true" className={cn("size-6", saved && "fill-current text-brand")} />
    </button>
  );
}
