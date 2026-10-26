"use server";

import { z } from "zod";
import { getMeasureUnitService } from "@/lib/inventory";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile unităților de măsură. Scrierea cere `products.write` (aceeași structură de catalog ca brandurile);
 * regulile (cod unic, «buc» protejată, zecimale care nu scad sub ce se folosește) sunt în serviciul din `@ecom/core`.
 */

const id = z.string().min(1).max(40);

export const createMeasureUnit = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const unit = await getMeasureUnitService().create(subject, input);
      return { ok: true as const, id: unit.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "measureUnit.create", entity: "measure_unit" },
);

export const updateMeasureUnit = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { id: unitId, ...patch } = z.object({ id }).passthrough().parse(input);
      await getMeasureUnitService().update(subject, unitId, patch);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "measureUnit.update", entity: "measure_unit" },
);
