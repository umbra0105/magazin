"use server";

import { z } from "zod";
import { getProductAssignmentsService, getProductService } from "@/lib/catalog";
import { productFailure as failure } from "@/lib/product-action-support";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";
import { parseZonedLocal } from "@/lib/zoned-time";

/**
 * Acțiunile editorului de produs. Fiecare trece prin `withPermission` cu o permisiune `products.*`
 * (refuzul se înregistrează în audit) și apoi prin serviciile din `@ecom/core`, care aplică poarta
 * pe câmpuri (`ProductUpdateGuard`): un Editor poate schimba doar conținutul; orice câmp de preț,
 * stoc, livrare, stare, brand sau categorie cere `products.write`, iar o cerere mixtă se respinge
 * întreagă. Clientul trimite DOAR câmpurile modificate. Prețul de achiziție nu trece pe aici:
 * are acțiunea lui separată, cu `products.cost.edit`.
 */

const id = z.string().min(1).max(40);
const patch = z.record(z.string().min(1).max(60), z.unknown());

const SALE_WINDOW_KEYS = ["saleStartsAt", "saleEndsAt"] as const;

/**
 * Capetele ferestrei de promoție vin ca „AAAA-LL-ZZTHH:mm” în ORA MAGAZINULUI (`regional.timezone`),
 * nu a browserului. Aici devin momente UTC; un șir gol înseamnă „fără capăt”.
 */
async function withSaleWindow(
  value: Record<string, unknown>,
): Promise<
  { ok: true; patch: Record<string, unknown> } | { ok: false; fields: Record<string, string> }
> {
  const out = { ...value };
  const { timezone } = await getSettings().getGroup("regional");
  const fields: Record<string, string> = {};
  for (const key of SALE_WINDOW_KEYS) {
    const raw = out[key];
    if (typeof raw !== "string") continue;
    if (raw === "") {
      out[key] = null;
      continue;
    }
    const date = parseZonedLocal(raw, timezone);
    if (date) out[key] = date.toISOString();
    else fields[key] = "Data sau ora nu există (verifică și schimbarea orei de vară).";
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, patch: out };
}

// Poarta cea mai largă: conținutul; restul câmpurilor cer `products.write` în serviciu.
export const saveProductFields = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, patch }).parse(input);
      const product = await getProductService().update(subject, parsed.id, parsed.patch);
      return { ok: true as const, product };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.update", entity: "product" },
);

export const createProduct = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { product } = await getProductService().create(subject, input);
      return { ok: true as const, id: product.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.create", entity: "product" },
);

export const saveVariantFields = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ variantId: id, patch }).parse(input);
      const window = await withSaleWindow(parsed.patch);
      if (!window.ok) {
        return { ok: false as const, code: "VALIDATION_ERROR", fields: window.fields };
      }
      const variant = await getProductService().updateVariant(
        subject,
        parsed.variantId,
        window.patch,
      );
      return { ok: true as const, variant };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.variant.update", entity: "product_variant" },
);

export const saveProductCategories = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, categories: z.unknown() }).parse(input);
      const rows = await getProductAssignmentsService().setCategories(
        subject,
        parsed.id,
        parsed.categories,
      );
      return { ok: true as const, categories: rows };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.categories.update", entity: "product" },
);

export const saveProductMedia = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, mediaIds: z.array(z.string().min(1).max(40)) }).parse(input);
      const service = getProductAssignmentsService();
      await service.setMedia(subject, parsed.id, { mediaIds: parsed.mediaIds });
      return { ok: true as const, items: await service.listMedia(subject, parsed.id) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.media.update", entity: "product" },
);

/** Verificarea unei adrese propuse (pentru câmpul „Adresă”): liberă, sau cine o folosește. */
export const checkProductSlug = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ slug: z.string().max(200), excludeId: id.optional() }).parse(input);
      const result = await getProductService().checkSlug(subject, parsed.slug, parsed.excludeId);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.slug.check", entity: "product" },
);
