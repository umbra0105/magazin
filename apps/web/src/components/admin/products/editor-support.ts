import type { ProductActionFailure } from "@/lib/product-action-support";

/** Ce se arată utilizatorului după un eșec de salvare: mesajul general și mesajele pe câmp. */
export interface FailureView {
  form: string;
  fields: Record<string, string>;
}

/** Codurile de domeniu care aparțin unui anumit câmp al formularului. */
const CODE_FIELDS: Readonly<Record<string, string>> = {
  CATALOG_SLUG_CONFLICT: "slug",
  CATALOG_SKU_CONFLICT: "sku",
  CATALOG_SALE_PRICE_INVALID: "salePrice",
  CATALOG_SALE_WINDOW_INVALID: "saleEndsAt",
  CATALOG_PRICE_INVALID: "price",
};

/**
 * Transformă un eșec de pe server în text pentru utilizator. Mesajul serverului are prioritate
 * (e scris pentru administrator, ex. cine folosește deja adresa); apoi textul din `errors` după cod.
 */
export function describeFailure(
  failure: ProductActionFailure,
  errors: Readonly<Record<string, string>>,
  texts: { generic: string; formError: string },
): FailureView {
  const fields: Record<string, string> = { ...(failure.fields ?? {}) };
  const text = failure.message ?? errors[failure.code] ?? texts.generic;
  const mapped = CODE_FIELDS[failure.code];
  if (mapped) {
    fields[mapped] = text;
    return { form: texts.formError, fields };
  }
  if (failure.code === "VALIDATION_ERROR") {
    return { form: Object.keys(fields).length > 0 ? texts.formError : text, fields };
  }
  return { form: text, fields };
}

/** Mută focusul pe primul câmp cu eroare (după ce erorile s-au randat). */
export function focusFirstInvalid(): void {
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    target?.focus();
  });
}
