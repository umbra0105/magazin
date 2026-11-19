"use server";

import { z } from "zod";
import { markNotificationsRead } from "@ecom/core";
import { getDb } from "@ecom/db";
import { withPermission } from "@/lib/session";

/**
 * Clopoțelul: marchează notificările ca citite DOAR pentru utilizatorul curent, și doar pe cele pe care le poate vedea (după
 * permisiunile lui). Orice utilizator de admin își poate citi propriile notificări.
 */
export const markNotificationsReadAction = withPermission(
  "admin.access",
  async (raw: unknown, subject): Promise<{ ok: true; marked: number } | { ok: false }> => {
    const parsed = z
      .strictObject({ ids: z.array(z.string().min(1).max(64)).max(100).optional() })
      .safeParse(raw);
    if (!parsed.success) return { ok: false };
    const marked = await markNotificationsRead(
      getDb(),
      { userId: subject.userId, permissions: subject.permissions },
      parsed.data.ids,
    );
    return { ok: true, marked };
  },
  { action: "notifications.read", entity: "admin_notification" },
);
