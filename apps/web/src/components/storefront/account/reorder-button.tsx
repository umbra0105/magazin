"use client";

import Link from "next/link";
import { useState } from "react";
import { StoreButton, storeButtonVariants } from "@ecom/ui";
import { reorderAction } from "@/app/(storefront)/cont/actions";
import { getMessages } from "@/messages";

const m = getMessages().account.detail;

/** «Comandă din nou»: doar adaugă în coș produsele care mai sunt disponibile (prețul îl calculează coșul, nu butonul). */
export function ReorderButton({ orderId }: { orderId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    setPending(true);
    setMessage(null);
    try {
      const result = await reorderAction({ orderId });
      if (!result.ok) setMessage(m.reorderFailed);
      else if (result.added === 0) setMessage(m.reorderNone);
      else {
        setMessage(m.reorderDone(result.added, result.skipped));
        setDone(true);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <StoreButton type="button" variant="secondary" onClick={run} disabled={pending}>
          {m.reorder}
        </StoreButton>
        {done ? (
          <Link href="/cos" className={storeButtonVariants({ variant: "primary" })}>
            {m.goToCart}
          </Link>
        ) : null}
      </div>
      <p
        role="status"
        aria-live="polite"
        className="min-h-6 text-sm text-ink-secondary"
        data-reorder-message
      >
        {message}
      </p>
    </div>
  );
}
