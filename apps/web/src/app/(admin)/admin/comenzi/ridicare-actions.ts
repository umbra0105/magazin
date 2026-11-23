"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { markOrderPickedUp } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "@/lib/admin-writes";
import { errorCodeOf } from "@/lib/error-code";
import { withPermission } from "@/lib/session";

/**
 * «Marchează ridicată» (Faza 14): pentru comenzile cu ridicare personală, adminul consemnează momentul ridicării; acesta pornește
 * fereastra de retur a clientului. Cere `orders.fulfill` (verificată pe server la fiecare apel); scrie auditul fără date ale clientului.
 */
export type PickupResult = { ok: true } | { ok: false; code: string };

export const markPickedUpAction = withPermission(
  "orders.fulfill",
  async (raw: unknown, subject): Promise<PickupResult> => {
    const parsed = z.strictObject({ orderId: z.string().min(1).max(64) }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "failed" };
    try {
      await markOrderPickedUp(getDb(), parsed.data.orderId, subject.email, new Date());
      await getAudit().record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "order.picked_up",
        entity: "order",
        entityId: parsed.data.orderId,
        after: {},
      });
      revalidatePath(`/admin/comenzi/${parsed.data.orderId}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: errorCodeOf(error, ["ORDER_"]) ?? "failed" };
    }
  },
  { action: "order.picked_up", entity: "order" },
);
