"use client";

import { useEffect, useState } from "react";
import { getPurchasePointsAction } from "@/app/(storefront)/puncte-produs/actions";

/**
 * Nota de puncte de lângă «Adaugă în coș», pentru varianta și cantitatea alese. Pagina din cache nu conține nimic din ea:
 * textul vine de la server după încărcare. Un răspuns depășit (altă variantă sau cantitate) se ignoră.
 */
export function PurchasePointsNote({
  variantId,
  quantityTicks,
}: {
  variantId: string;
  quantityTicks: string;
}) {
  const [note, setNote] = useState<{ key: string; text: string | null } | null>(null);
  const key = `${variantId}:${quantityTicks}`;
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      getPurchasePointsAction({ variantId, quantityTicks })
        .then((text) => {
          if (current) setNote({ key: `${variantId}:${quantityTicks}`, text });
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [variantId, quantityTicks]);
  if (!note?.text || note.key !== key) return null;
  return (
    <p className="text-sm font-medium" data-product-points>
      {note.text}
    </p>
  );
}
