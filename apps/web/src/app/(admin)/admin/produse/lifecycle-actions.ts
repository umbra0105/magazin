"use server";

import { z } from "zod";
import { getProductLifecycleService } from "@/lib/catalog";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Ciclul de viață al produsului: duplicare, arhivare, coș de gunoi și ștergere definitivă. TOATE
 * acțiunile cer `products.write` prin `withPermission` (refuzul se înregistrează în audit), iar
 * `ProductLifecycleService` o re-verifică. Operațiile pe selecție cer confirmare explicită cu numărul
 * exact de produse (cel mult 50, tot sau nimic); ștergerea definitivă cere adresa produsului.
 * Prețul de achiziție nu apare aici nicăieri.
 */

const idInput = z.strictObject({ id: z.string().min(1).max(40) });

export const duplicateProduct = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { id } = idInput.parse(input);
      const result = await getProductLifecycleService().duplicate(subject, id);
      return {
        ok: true as const,
        id: result.product.id,
        title: result.product.title,
        skipped: result.skipped,
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.duplicate", entity: "product" },
);

export const archiveProducts = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductLifecycleService().archive(subject, input);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.archive", entity: "product" },
);

export const unarchiveProducts = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductLifecycleService().unarchive(subject, input);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.unarchive", entity: "product" },
);

export const deleteProducts = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductLifecycleService().softDelete(subject, input);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.delete", entity: "product" },
);

export const restoreProducts = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductLifecycleService().restore(subject, input);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.restore", entity: "product" },
);

/** Ce s-ar șterge odată cu produsul și ce l-ar bloca (citire, pentru dialogul de confirmare). */
export const describeProductPurge = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { id } = idInput.parse(input);
      const impact = await getProductLifecycleService().describePurge(subject, id);
      return { ok: true as const, impact };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.purge.describe", entity: "product" },
);

export const purgeProduct = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductLifecycleService().purge(subject, input);
      return { ok: true as const, ...result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.purge", entity: "product" },
);
