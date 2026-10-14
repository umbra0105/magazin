"use server";

import { z } from "zod";
import { getProductService } from "@/lib/catalog";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile listei de produse: editare inline și în masă. Fiecare trece prin `withPermission` cu o
 * permisiune `products.*` (refuzul se înregistrează în audit) și apoi prin `ProductService`, care
 * folosește `ProductUpdateGuard`: un Editor poate schimba doar titlul, orice alt câmp cere
 * `products.write`, iar cererea mixtă se respinge întreagă. Prețul de achiziție nu apare aici nicăieri.
 */

const inlineInput = z.discriminatedUnion("field", [
  z.object({ id: z.string().min(1).max(40), field: z.literal("title"), value: z.string() }),
  z.object({ id: z.string().min(1).max(40), field: z.literal("status"), value: z.string() }),
  z.object({ id: z.string().min(1).max(40), field: z.literal("stockStatus"), value: z.string() }),
  z.object({ id: z.string().min(1).max(40), field: z.literal("price"), value: z.number() }),
]);

// Poarta cea mai largă: titlul (conținut); starea, stocul și prețul cer `products.write` în serviciu.
export const updateProductInline = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = inlineInput.parse(input);
      const products = getProductService();
      if (parsed.field === "price") {
        await products.updateSingleVariantPrice(subject, parsed.id, parsed.value);
      } else {
        await products.update(subject, parsed.id, { [parsed.field]: parsed.value });
      }
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.update", entity: "product" },
);

export const bulkUpdateProducts = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductService().bulkUpdate(subject, input);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.bulk_update", entity: "product" },
);
