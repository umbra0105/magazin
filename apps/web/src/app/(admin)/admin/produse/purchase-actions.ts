"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { parseMoneyInput } from "@/lib/money-input";
import { getPurchasePriceService } from "@/lib/purchase-price";
import { withPermission } from "@/lib/session";

/**
 * Salvarea prețului de achiziție (NIR, fără TVA) al unei variante, dintr-un formular randat pe
 * SERVER (nu trece prin componente client). Poarta cere `products.cost.edit`, iar
 * `CostPriceService.setCost` cere în plus `products.cost.view` și validează valoarea și data.
 * Intrarea e text (ce a tastat adminul), convertit în bani aici, fără `float`. Rezultatul se
 * comunică prin redirecționare cu un cod de stare (fără valori): nici auditul, nici logurile, nici
 * URL-ul nu conțin vreo sumă.
 */

const input = z.object({
  productId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  variantId: z.string().min(1).max(40),
  amount: z.string().max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type PurchaseStatus = "saved" | "history" | "invalid" | "failed";

function back(productId: string, status: PurchaseStatus): never {
  redirect(`/admin/produse/${productId}?tab=preturi&purchase=${status}`);
}

export const savePurchasePrice = withPermission(
  "products.cost.edit",
  async (formData: FormData, subject): Promise<void> => {
    const parsed = input.safeParse({
      productId: formData.get("productId"),
      variantId: formData.get("variantId"),
      amount: formData.get("amount"),
      date: formData.get("date"),
    });
    if (!parsed.success) redirect("/admin/produse");
    const { productId, variantId, amount, date } = parsed.data;

    const bani = parseMoneyInput(amount);
    if (bani === null) back(productId, "invalid");

    let status: PurchaseStatus;
    try {
      const result = await getPurchasePriceService().setCost(subject, {
        variantId,
        costPrice: bani,
        effectiveDate: new Date(`${date}T00:00:00.000Z`),
        source: "manual",
      });
      status = result.applied ? "saved" : "history";
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "VALIDATION_ERROR") status = "invalid";
      else if (code === "CATALOG_VARIANT_NOT_FOUND") status = "failed";
      else throw error;
    }
    back(productId, status);
  },
  { action: "product.cost.update", entity: "product_variant" },
);
