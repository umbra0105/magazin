"use server";

import { z } from "zod";
import {
  getProductAssignmentsService,
  getProductAttributesService,
  getProductListService,
  getProductRelationsService,
  getProductService,
} from "@/lib/catalog";
import { parseMoneyInput } from "@/lib/money-input";
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

// ---------------------------------------------------------------------------
// Blocul 11b: atribute, relații, variante. Toate cer `products.write` (în poartă și în servicii).
// ---------------------------------------------------------------------------

const optionInput = z.object({
  name: z.string().max(100),
  values: z.array(z.string().max(100)).max(60),
});

export const saveProductAttributes = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, values: z.unknown() }).parse(input);
      const entries = await getProductAttributesService().set(subject, parsed.id, {
        values: parsed.values,
      });
      return {
        ok: true as const,
        values: entries.map((e) => ({ attributeId: e.attribute.id, value: e.value })),
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.attributes.update", entity: "product" },
);

/** Relațiile unui produs, în forma trimisă clientului (fără câmpuri interne). */
function relationRows(
  rows: Awaited<ReturnType<ReturnType<typeof getProductRelationsService>["list"]>>,
) {
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    position: r.position,
    direction: r.direction,
    product: r.product,
  }));
}

export const addProductRelation = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, relatedProductId: id, type: z.string().max(40) }).parse(input);
      const rows = await getProductRelationsService().add(subject, parsed.id, {
        relatedProductId: parsed.relatedProductId,
        type: parsed.type,
      });
      return { ok: true as const, relations: relationRows(rows) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.relation.add", entity: "product" },
);

export const removeProductRelation = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, relationId: id }).parse(input);
      const rows = await getProductRelationsService().remove(subject, parsed.id, parsed.relationId);
      return { ok: true as const, relations: relationRows(rows) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.relation.remove", entity: "product" },
);

export const reorderProductRelations = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z
        .object({ id, type: z.string().max(40), orderedIds: z.array(id).max(60) })
        .parse(input);
      const rows = await getProductRelationsService().reorder(subject, parsed.id, {
        type: parsed.type,
        orderedIds: parsed.orderedIds,
      });
      return { ok: true as const, relations: relationRows(rows) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.relation.reorder", entity: "product" },
);

/** Căutarea produsului asociat: titlu, SKU, EAN sau cod producător (aceeași căutare ca în listă). */
export const searchRelatedProducts = withPermission(
  "products.read",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ q: z.string().max(100), excludeId: id }).parse(input);
      if (parsed.q.trim().length < 2) return { ok: true as const, results: [] };
      const { page } = await getProductListService().list(subject, {
        q: parsed.q,
        size: "25",
      });
      return {
        ok: true as const,
        results: page.rows
          .filter((row) => row.id !== parsed.excludeId)
          .map((row) => ({ id: row.id, title: row.title, sku: row.sku, status: row.status })),
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.relation.search", entity: "product" },
);

export const previewProductVariants = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z
        .object({
          id,
          options: z.array(optionInput).max(10),
          baseSku: z.string().max(64).optional(),
        })
        .parse(input);
      const plan = await getProductService().previewVariantPlan(subject, parsed.id, {
        options: parsed.options,
        ...(parsed.baseSku?.trim() && { baseSku: parsed.baseSku.trim() }),
      });
      return { ok: true as const, plan };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.variants.preview", entity: "product" },
);

export const generateProductVariants = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z
        .object({
          id,
          options: z.array(optionInput).max(10),
          price: z.string().max(40),
          baseSku: z.string().max(64).optional(),
        })
        .parse(input);
      const price = parseMoneyInput(parsed.price);
      if (price === null) {
        return {
          ok: false as const,
          code: "VALIDATION_ERROR",
          fields: { price: "Introdu un preț valid, cu cel mult 2 zecimale." },
        };
      }
      const result = await getProductService().generateVariants(subject, parsed.id, {
        options: parsed.options,
        price,
        ...(parsed.baseSku?.trim() && { baseSku: parsed.baseSku.trim() }),
      });
      return {
        ok: true as const,
        created: result.created.length,
        existing: result.existing,
        orphaned: result.orphaned,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.variants.generate", entity: "product" },
);

export const deleteProductVariant = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ variantId: id }).parse(input);
      const result = await getProductService().deleteVariant(subject, parsed.variantId);
      return { ok: true as const, remaining: result.remaining };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.variant.delete", entity: "product_variant" },
);
