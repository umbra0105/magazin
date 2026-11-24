"use server";

import { z } from "zod";
import { getCustomerGroupService } from "@/lib/customers";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Atribuirea grupului de clienți (Faza 15). Cere `customers.write`, verificat pe server la fiecare apel; serviciul din `@ecom/core`
 * validează grupul (existent și activ), limitează atribuirea în masă și scrie auditul (doar identificatori și numere).
 */

const id = z.string().min(1).max(64);
const groupId = z.union([id, z.null()]);

export const assignCustomerGroup = withPermission(
  "customers.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ userId: id, groupId }).parse(input);
      const out = await getCustomerGroupService().assign(subject, parsed.userId, parsed.groupId);
      return { ok: true as const, previousGroupId: out.previousGroupId };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "customer.group.assign", entity: "user" },
);

export const assignCustomerGroupBulk = withPermission(
  "customers.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ userIds: z.array(id).min(1).max(500), groupId }).parse(input);
      const out = await getCustomerGroupService().assignBulk(
        subject,
        parsed.userIds,
        parsed.groupId,
      );
      return { ok: true as const, moved: out.moved.length, missing: out.missing.length };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "customer.group.assign_bulk", entity: "customer_group" },
);
