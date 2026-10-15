"use server";

import { z } from "zod";
import { productFailure as failure } from "@/lib/product-action-support";
import { getProductDocumentsService } from "@/lib/product-documents";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile documentelor de produs, în afara încărcării (care are ruta ei: fișierul nu trece prin
 * server actions). Toate cer `products.content.write` (documentele sunt conținut) și trec prin
 * `ProductDocumentsService`, care aplică poarta de câmpuri și înregistrează audit fără conținut.
 */

const id = z.string().min(1).max(40);

export const updateProductDocument = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ documentId: id, patch: z.unknown() }).parse(input);
      const document = await getProductDocumentsService().update(
        subject,
        parsed.documentId,
        parsed.patch,
      );
      return { ok: true as const, document };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.document.update", entity: "product" },
);

export const deleteProductDocument = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ documentId: id }).parse(input);
      await getProductDocumentsService().remove(subject, parsed.documentId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.document.delete", entity: "product" },
);

export const reorderProductDocuments = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, orderedIds: z.array(id).max(60) }).parse(input);
      const documents = await getProductDocumentsService().reorder(
        subject,
        parsed.id,
        parsed.orderedIds,
      );
      return { ok: true as const, order: documents.map((d) => d.id) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.document.reorder", entity: "product" },
);
