"use server";

import { z } from "zod";
import { trackOrder, type OrderSummary } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { allowCheckoutRequest } from "@/lib/checkout";

/**
 * Urmărirea unei comenzi de către oaspete (Faza 9): număr + email. Răspunsul e IDENTIC pentru orice pereche necunoscută (nu spune
 * dacă numărul sau emailul e cel greșit), cererile sunt limitate pe IP, iar rezumatul nu conține strada, telefonul sau emailul.
 */
const input = z.object({
  number: z.string().trim().min(1).max(40),
  email: z.string().trim().toLowerCase().email().max(254),
});

export type TrackResult =
  | { status: "found"; order: SerializedOrder }
  | { status: "not_found" | "invalid" | "rate_limited" | "failed" };

/** `OrderSummary` cu data ca text (nu trece `Date` prin acțiune). */
export type SerializedOrder = Omit<OrderSummary, "placedAt" | "reservationExpiresAt"> & {
  placedAt: string;
  reservationExpiresAt: string | null;
};

export async function trackOrderAction(raw: unknown): Promise<TrackResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { status: "invalid" };
  if (!(await allowCheckoutRequest("track"))) return { status: "rate_limited" };
  try {
    const order = await trackOrder(getDb(), parsed.data);
    if (!order) return { status: "not_found" };
    return {
      status: "found",
      order: {
        ...order,
        placedAt: order.placedAt.toISOString(),
        reservationExpiresAt: order.reservationExpiresAt?.toISOString() ?? null,
      },
    };
  } catch (error) {
    getLogger().error({ err: error }, "urmărirea comenzii a eșuat");
    return { status: "failed" };
  }
}
