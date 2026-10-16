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
  "FEATURE_DISABLED",
  "DIAGRAM_NOT_FOUND",
  "DIAGRAM_MEDIA_INVALID",
  "DIAGRAM_DELETE_MISMATCH",
  "DIAGRAM_HOTSPOT_NOT_FOUND",
  "DIAGRAM_HOTSPOT_INVALID",
  "DIAGRAM_HOTSPOT_NUMBER_TAKEN",
  "DIAGRAM_HOTSPOT_LIMIT",
  "DOCUMENT_NOT_FOUND",
  "DOCUMENT_LIMIT",
  "DOCUMENT_EMPTY",
  "DOCUMENT_TYPE_UNSUPPORTED",
  "DOCUMENT_ACTIVE_CONTENT",
  "DOCUMENT_CORRUPT",
  "DOCUMENT_STORAGE_UNAVAILABLE",
  "CATALOG_VARIANT_LAST",
  "CATALOG_VARIANT_LIMIT",
  "CATALOG_OPTIONS_LIMIT",
  "CATALOG_OPTION_VALUES_LIMIT",
  "CATALOG_OPTIONS_EMPTY",
  "CATALOG_OPTION_NAME_EMPTY",
  "CATALOG_OPTION_DUPLICATE",
  "CATALOG_OPTION_VALUES_EMPTY",
  "CATALOG_SKU_EMPTY",
  "CATALOG_RELATION_SELF",
  "CATALOG_RELATION_DUPLICATE",
  "CATALOG_RELATION_LIMIT",
  "CATALOG_RELATION_NOT_FOUND",
  "CATALOG_RELATION_MISMATCH",
  "ATTRIBUTE_NOT_FOUND",
  "ATTRIBUTE_VALUE_INVALID",
  "ATTRIBUTE_VALUE_DUPLICATE",
  "ATTRIBUTE_CODE_CONFLICT",
  "ATTRIBUTE_TYPE_LOCKED",
  "ATTRIBUTE_IN_USE",
  "ATTRIBUTE_UNIT_INVALID",
  "ATTRIBUTE_FILTERABLE_INVALID",
  "ATTRIBUTE_OPTIONS_INVALID",
  "ATTRIBUTE_OPTIONS_LIMIT",
  "ATTRIBUTE_OPTION_NOT_FOUND",
  "ATTRIBUTE_OPTION_DUPLICATE",
  "ATTRIBUTE_OPTION_IN_USE",
  "ATTRIBUTE_OPTIONS_MISMATCH",
  "CATALOG_BULK_COUNT_MISMATCH",
  "CATALOG_BULK_INVALID",
  "CATALOG_BULK_PRICE_OUT_OF_RANGE",
  "CATALOG_LIFECYCLE_INVALID",
  "CATALOG_PRODUCT_NOT_DELETED",
  "CATALOG_PURGE_CONFIRM_MISMATCH",
  "CATALOG_PRODUCT_REFERENCED",
  "IMPORT_NOT_FOUND",
  "IMPORT_STATE_INVALID",
  "IMPORT_STALE",
  "IMPORT_NOTHING_TO_APPLY",
  "IMPORT_FILE_CHANGED",
  "IMPORT_QUEUE_UNAVAILABLE",
  "IMPORT_MAPPING_COST",
  "IMPORT_MAPPING_INVALID",
  "IMPORT_FILE_EMPTY",
  "IMPORT_FILE_CORRUPT",
  "IMPORT_FILE_UNSUPPORTED",
  "IMPORT_FILE_MACROS",
  "IMPORT_FILE_TOO_LARGE",
  "IMPORT_FILE_TOO_MANY_ROWS",
  "IMPORT_FILE_TOO_MANY_COLUMNS",
  "IMPORT_FILE_CELL_TOO_LONG",
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
