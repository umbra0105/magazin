import type { Db } from "../db-tx";

/**
 * Programul de ridicare personală (setarea `company.pickupHours`, Faza 13): text liber, scurt, fără HTML, fără reguli de business.
 * Se arată lângă adresa de ridicare (checkout, confirmare, pagina comenzii, email), DOAR când e completat. Se citește la afișare
 * (nu din snapshot): programul magazinului de azi, nu cel de la plasare. Șirul gol înseamnă «nu se arată».
 */
export const PICKUP_HOURS_SETTING = "company.pickupHours";

export function pickupHoursFromValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

export async function readPickupHours(db: Db): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: PICKUP_HOURS_SETTING } });
  return pickupHoursFromValue(row?.value);
}
