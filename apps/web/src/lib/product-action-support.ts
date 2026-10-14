/**
 * Rezultatul de eșec comun acțiunilor de produs din admin. Eroarea e clasificată după codul stabil
 * (modulele pot fi duplicate în Next: nu `instanceof`). Mesajele din nucleu sunt scrise pentru
 * administrator și nu conțin valori sensibile; la validare, doar calea și mesajul fiecărei probleme.
 */

export interface ProductActionFailure {
  ok: false;
  code: string;
  message?: string;
  /** La `VALIDATION_ERROR`: mesajul pe câmp (cheie = calea din cerere). */
  fields?: Record<string, string>;
}

const DOMAIN_CODES = new Set([
  "AUTH_FORBIDDEN",
  "CATALOG_PRODUCT_NOT_FOUND",
  "CATALOG_PRODUCT_DELETED",
  "CATALOG_VARIANT_NOT_FOUND",
  "CATALOG_NOT_SINGLE_VARIANT",
  "CATALOG_SLUG_CONFLICT",
  "CATALOG_SKU_CONFLICT",
  "CATALOG_SALE_PRICE_INVALID",
  "CATALOG_SALE_WINDOW_INVALID",
  "CATALOG_PRICE_INVALID",
  "CATALOG_MEDIA_INVALID",
  "CATALOG_BULK_COUNT_MISMATCH",
  "CATALOG_BULK_INVALID",
  "CATALOG_BULK_PRICE_OUT_OF_RANGE",
  "CATEGORY_NOT_FOUND",
  "BRAND_NOT_FOUND",
  "VALIDATION_ERROR",
  "AUDIT_WRITE_FAILED",
]);

function issueFields(details: unknown): Record<string, string> | undefined {
  const issues = (details as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return undefined;
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message === "string") out[typeof path === "string" && path ? path : "_"] ??= message;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function productFailure(error: unknown): ProductActionFailure {
  const e = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    details?: unknown;
  } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  if (code && DOMAIN_CODES.has(code)) {
    const fields = code === "VALIDATION_ERROR" ? issueFields(e?.details) : undefined;
    return {
      ok: false,
      code,
      ...(typeof e?.message === "string" && { message: e.message }),
      ...(fields && { fields }),
    };
  }
  if (e?.name === "ZodError") return { ok: false, code: "VALIDATION_ERROR" };
  throw error;
}
