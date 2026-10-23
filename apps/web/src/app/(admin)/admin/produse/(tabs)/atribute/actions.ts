"use server";

import { z } from "zod";
import { getAttributeService } from "@/lib/catalog";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Definițiile atributelor, din pagina Atribute. Toate cer `products.write` (permisiune dedicată nu
 * se justifică: sunt date de catalog la același nivel cu prețul și starea) și trec prin
 * `AttributeService`, care validează cu Zod strict, refuză schimbarea tipului sau ștergerea cât
 * atributul are valori și înregistrează fiecare scriere în audit.
 */

const id = z.string().min(1).max(40);

export const createAttribute = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const attribute = await getAttributeService().create(subject, input);
      return { ok: true as const, attribute };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.create", entity: "attribute" },
);

export const updateAttribute = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, patch: z.unknown() }).parse(input);
      const attribute = await getAttributeService().update(subject, parsed.id, parsed.patch);
      return { ok: true as const, attribute };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.update", entity: "attribute" },
);

export const deleteAttribute = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id }).parse(input);
      await getAttributeService().delete(subject, parsed.id);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.delete", entity: "attribute" },
);

export const addAttributeOption = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ attributeId: id, value: z.string().max(200) }).parse(input);
      const option = await getAttributeService().addOption(subject, parsed.attributeId, {
        value: parsed.value,
      });
      return { ok: true as const, option };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.option.add", entity: "attribute" },
);

export const renameAttributeOption = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ optionId: id, value: z.string().max(200) }).parse(input);
      await getAttributeService().renameOption(subject, parsed.optionId, { value: parsed.value });
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.option.rename", entity: "attribute" },
);

export const deleteAttributeOption = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ optionId: id }).parse(input);
      await getAttributeService().deleteOption(subject, parsed.optionId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.option.delete", entity: "attribute" },
);

export const reorderAttributeOptions = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ attributeId: id, orderedIds: z.array(id).max(200) }).parse(input);
      await getAttributeService().reorderOptions(subject, parsed.attributeId, {
        orderedIds: parsed.orderedIds,
      });
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "attribute.option.reorder", entity: "attribute" },
);
