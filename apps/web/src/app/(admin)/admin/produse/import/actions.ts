"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod";
import { CATALOG_TAG } from "@ecom/core";
import { productFailure as failure } from "@/lib/product-action-support";
import { checkImportStepRate, getProductImportService } from "@/lib/product-imports";
import { withPermission } from "@/lib/session";

/**
 * Pașii importului de produse după încărcare (încărcarea are ruta ei API): reanalizare cu alt
 * delimitator, verificare (dry-run, fără modificări în catalog), aplicare, stare și anulare. TOATE cer
 * `products.write` prin `withPermission` (refuzul se înregistrează în audit), iar serviciul o
 * re-verifică și limitează fiecare operație la importul utilizatorului curent. Prețul de achiziție nu
 * apare aici nicăieri: o coloană de cost mapată e refuzată în serviciu.
 */

const idInput = z.strictObject({ importId: z.string().min(1).max(40) });
const analyzeInput = z.strictObject({
  importId: z.string().min(1).max(40),
  delimiter: z.enum([",", ";", "\t"]).optional(),
});

export const analyzeProductImport = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { importId, delimiter } = analyzeInput.parse(input);
      await checkImportStepRate(subject.userId);
      const analysis = await getProductImportService().analyze(subject, importId, {
        ...(delimiter && { delimiter }),
      });
      return { ok: true as const, analysis };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.import.analyze", entity: "product_import" },
);

export const validateProductImport = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      await checkImportStepRate(subject.userId);
      const validation = await getProductImportService().validate(subject, input);
      return { ok: true as const, validation };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.import.validate", entity: "product_import" },
);

export const applyProductImport = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const result = await getProductImportService().apply(subject, input);
      if (result.mode === "sync") revalidateTag(CATALOG_TAG);
      return { ok: true as const, result };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.import.apply", entity: "product_import" },
);

/** Starea unui import (interogată periodic de interfață). La finalizare invalidează cache-ul catalogului. */
export const getProductImportStatus = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { importId } = idInput.parse(input);
      const status = await getProductImportService().status(subject, importId);
      // jobul din fundal nu poate invalida cache-ul Next: o face aplicația când vede finalizarea
      if (status.status === "completed") revalidateTag(CATALOG_TAG);
      return { ok: true as const, status };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.import.status", entity: "product_import" },
);

/** Reia descărcarea imaginilor unui import (cele în așteptare și cele eșuate). Doar cine a pornit importul. */
export const retryProductImportImages = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { importId } = idInput.parse(input);
      await getProductImportService().retryImages(subject, importId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.import.images.retry", entity: "product_import" },
);

export const cancelProductImport = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { importId } = idInput.parse(input);
      await getProductImportService().cancel(subject, importId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.import.cancel", entity: "product_import" },
);
