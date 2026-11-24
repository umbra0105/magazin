"use server";

import { z } from "zod";
import { nirViewForClient } from "@ecom/core";
import { getNirImportService } from "@/lib/nir-imports";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile importului NIR (Faza 15). Confirmarea cere `products.cost.import` (și serviciul verifică și `products.cost.view`);
 * starea importului cere `products.cost.view`. Răspunsurile către interfață NU conțin prețuri de achiziție (`nirViewForClient`).
 */

const id = z.string().min(1).max(64);

export const confirmNirImport = withPermission(
  "products.cost.import",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id }).parse(input);
      const view = await getNirImportService().confirmImport(subject, parsed.id);
      return { ok: true as const, import: nirViewForClient(view) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.cost.import", entity: "nir_import" },
);

export const getNirImportStatus = withPermission(
  "products.cost.view",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id }).parse(input);
      const view = await getNirImportService().get(subject, parsed.id);
      return { ok: true as const, import: nirViewForClient(view) };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "product.cost.import.status", entity: "nir_import" },
);
