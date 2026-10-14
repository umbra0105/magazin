"use server";

import { z } from "zod";
import { getProductService } from "@/lib/catalog";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile listei de produse: editare inline și în masă. Fiecare trece prin `withPermission` cu o
 * permisiune `products.*` (refuzul se înregistrează în audit) și apoi prin `ProductService`, care
 * folosește `ProductUpdateGuard`: un Editor poate schimba doar titlul, orice alt câmp cere
 * `products.write`, iar cererea mixtă se respinge întreagă. Prețul de achiziție nu apare aici nicăieri.
 */

export type ProductActionFailure = { ok: false; code: string; message?: string };

const DOMAIN_CODES = new Set([
  "AUTH_FORBIDDEN",
  "CATALOG_PRODUCT_NOT_FOUND",
  "CATALOG_PRODUCT_DELETED",
  "CATALOG_NOT_SINGLE_VARIANT",
  "CATALOG_SLUG_CONFLICT",
  "CATALOG_SALE_PRICE_INVALID",
  "CATALOG_BULK_COUNT_MISMATCH",
  "CATALOG_BULK_INVALID",
  "CATALOG_BULK_PRICE_OUT_OF_RANGE",
  "CATEGORY_NOT_FOUND",
  "BRAND_NOT_FOUND",
  "VALIDATION_ERROR",
  "AUDIT_WRITE_FAILED",
]);

/** Clasificare după codul stabil (module duplicate în Next: nu `instanceof`). */
function failure(error: unknown): ProductActionFailure {
  const e = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  if (code && DOMAIN_CODES.has(code)) {
    return { ok: false, code, ...(typeof e?.message === "string" && { message: e.message }) };
  }
  if (e?.name === "ZodError") return { ok: false, code: "VALIDATION_ERROR" };
  throw error;
}

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
