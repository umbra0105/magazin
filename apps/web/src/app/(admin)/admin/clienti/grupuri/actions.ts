"use server";

import { z } from "zod";
import { getCustomerGroupService } from "@/lib/customers";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile grupurilor de clienți (Faza 15). Creare, editare și ștergere cer `customers.groups.manage`, verificat pe server.
 * Regulile (tipul și procentul se potrivesc, «Client standard» e protejat, un grup cu clienți nu se șterge) sunt în serviciu.
 */

const id = z.string().min(1).max(64);

export const createCustomerGroup = withPermission(
  "customers.groups.manage",
  async (input: unknown, subject) => {
    try {
      const group = await getCustomerGroupService().create(subject, input);
      return { ok: true as const, id: group.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "customerGroup.create", entity: "customer_group" },
);

export const updateCustomerGroup = withPermission(
  "customers.groups.manage",
  async (input: unknown, subject) => {
    try {
      const { id: groupId, ...patch } = z.object({ id }).passthrough().parse(input);
      await getCustomerGroupService().update(subject, groupId, patch);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "customerGroup.update", entity: "customer_group" },
);

export const deleteCustomerGroup = withPermission(
  "customers.groups.manage",
  async (input: unknown, subject) => {
    try {
      const { id: groupId } = z.object({ id }).parse(input);
      await getCustomerGroupService().remove(subject, groupId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "customerGroup.delete", entity: "customer_group" },
);
