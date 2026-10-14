"use server";

import { z } from "zod";
import { getCategoryService } from "@/lib/catalog";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile categoriilor. Fiecare: `withPermission` cu o permisiune din catalog (refuzul se
 * înregistrează în audit), apoi `CategoryService`, care verifică din nou și pe câmpuri
 * (conținut / structură / legacy). Datele sunt validate cu Zod în serviciu (scheme stricte).
 * Erorile de domeniu se întorc ca rezultat cu cod stabil, ca interfața să arate mesajul potrivit;
 * mesajul serverului (în română, fără valori sensibile) se întoarce doar pentru codurile de mai jos.
 */

export type CategoryActionFailure = { ok: false; code: string; message?: string };

const DOMAIN_CODES = new Set([
  "CATEGORY_NOT_FOUND",
  "CATEGORY_PARENT_NOT_FOUND",
  "CATEGORY_SELF_PARENT",
  "CATEGORY_CYCLE",
  "CATEGORY_TOO_DEEP",
  "CATEGORY_SLUG_CONFLICT",
  "CATEGORY_IMAGE_NOT_FOUND",
  "CATEGORY_HAS_CHILDREN",
  "CATEGORY_HAS_PRODUCTS",
  "AUTH_FORBIDDEN",
  "AUDIT_WRITE_FAILED",
]);

/** Clasificare după codul stabil, nu `instanceof` (module duplicate în Next). */
function failure(error: unknown): CategoryActionFailure {
  const e = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  if (code && DOMAIN_CODES.has(code)) {
    return {
      ok: false,
      code,
      ...(typeof e?.message === "string" && { message: e.message }),
    };
  }
  if (code === "VALIDATION_ERROR" && typeof e?.message === "string") {
    return { ok: false, code, message: e.message };
  }
  throw error;
}

const id = z.string().min(1).max(40);

export const createCategory = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const category = await getCategoryService().create(subject, input);
      return { ok: true as const, id: category.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "category.create", entity: "category" },
);

// Poarta cea mai largă: conținutul; câmpurile de structură cer permisiuni mai înalte, în serviciu.
export const updateCategory = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const { id: categoryId, ...patch } = z.object({ id }).passthrough().parse(input);
      await getCategoryService().update(subject, categoryId, patch);
      return { ok: true as const };
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "ZodError") {
        return { ok: false as const, code: "VALIDATION_ERROR" };
      }
      return failure(error);
    }
  },
  { action: "category.update", entity: "category" },
);

export const moveCategory = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { id: categoryId, ...target } = z.object({ id }).passthrough().parse(input);
      await getCategoryService().move(subject, categoryId, target);
      return { ok: true as const };
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "ZodError") {
        return { ok: false as const, code: "VALIDATION_ERROR" };
      }
      return failure(error);
    }
  },
  { action: "category.move", entity: "category" },
);

export const deleteCategory = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { id: categoryId } = z.object({ id }).parse(input);
      await getCategoryService().delete(subject, categoryId);
      return { ok: true as const };
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "ZodError") {
        return { ok: false as const, code: "VALIDATION_ERROR" };
      }
      return failure(error);
    }
  },
  { action: "category.delete", entity: "category" },
);
