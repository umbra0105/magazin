"use server";

import { z } from "zod";
import { getPurchasePointsNote } from "@/lib/purchase-points";

/**
 * «Primești X puncte la această achiziție» (Faza 15b): acțiune de server (POST, niciodată în cache) apelată din browser după
 * încărcarea paginii de produs. Intrarea e validată; la orice problemă nu se arată nimic.
 */
const request = z.object({
  variantId: z.string().min(1).max(64),
  quantityTicks: z.string().regex(/^\d{1,15}$/),
});

export async function getPurchasePointsAction(input: unknown): Promise<string | null> {
  const parsed = request.safeParse(input);
  if (!parsed.success) return null;
  try {
    return await getPurchasePointsNote({
      variantId: parsed.data.variantId,
      quantityTicks: BigInt(parsed.data.quantityTicks),
    });
  } catch {
    return null;
  }
}
