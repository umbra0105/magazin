"use server";

import { z } from "zod";
import { DomainError } from "@ecom/shared";
import { getLoyaltyAdminService } from "@/lib/loyalty-admin";
import { getFeatureFlags } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Ajustarea manuală a punctelor (Faza 15b). Cere `loyalty.adjust`, verificat pe server aici și în serviciu; serviciul din
 * `@ecom/core` validează intrarea, scrie registrul și auditul (doar identificatori și numere). Cu flag-ul oprit nu se face nimic.
 */
const input = z.strictObject({
  customerId: z.string().min(1).max(64),
  points: z.number().int(),
  reason: z.string().max(2_000),
  requestKey: z.string().uuid(),
});

export type AdjustPointsResult =
  { ok: true; balance: number } | { ok: false; code: "invalid" | "insufficient" | "failed" };

export const adjustLoyaltyPoints = withPermission(
  "loyalty.adjust",
  async (raw: unknown, subject): Promise<AdjustPointsResult> => {
    if (!(await getFeatureFlags().isEnabled("loyalty"))) return { ok: false, code: "failed" };
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const result = await getLoyaltyAdminService().adjust(subject, parsed.data);
      return { ok: true, balance: result.balance };
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === "LOYALTY_INSUFFICIENT_POINTS")
          return { ok: false, code: "insufficient" };
        if (error.code === "VALIDATION_ERROR") return { ok: false, code: "invalid" };
      }
      throw error;
    }
  },
  { action: "loyalty.adjust", entity: "loyalty_account" },
);
