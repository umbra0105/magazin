"use server";

import { z } from "zod";
import { getWarehouseService } from "@/lib/inventory";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile depozitelor (13c). Scrierea cere `inventory.write`; regulile (steagul de multi-depozit oprit → `FEATURE_DISABLED`
 * înaintea drepturilor din serviciu, nume unic, depozitul implicit protejat, dezactivare refuzată cu stoc) și auditul sunt în
 * `WarehouseService` din `@ecom/core`. Acțiunea nu verifică steagul separat: serviciul îl citește la fiecare apel.
 */

const id = z.string().min(1).max(40);

export const createWarehouse = withPermission(
  "inventory.write",
  async (input: unknown, subject) => {
    try {
      const warehouse = await getWarehouseService().create(subject, input);
      return { ok: true as const, id: warehouse.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "warehouse.create", entity: "warehouse" },
);

export const renameWarehouse = withPermission(
  "inventory.write",
  async (input: unknown, subject) => {
    try {
      const { id: warehouseId, ...patch } = z.object({ id }).passthrough().parse(input);
      await getWarehouseService().rename(subject, warehouseId, patch);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "warehouse.rename", entity: "warehouse" },
);

export const setWarehouseActive = withPermission(
  "inventory.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.strictObject({ id, active: z.boolean() }).parse(input);
      const service = getWarehouseService();
      if (parsed.active) await service.activate(subject, parsed.id);
      else await service.deactivate(subject, parsed.id);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "warehouse.setActive", entity: "warehouse" },
);
