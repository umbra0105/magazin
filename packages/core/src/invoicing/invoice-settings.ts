import { settingGroups } from "../settings/registry";
import type { Db } from "../db-tx";

/** Setările facturării (`invoicing.*`), citite direct din tabelă, cu valorile implicite din registru pentru cheile lipsă. */
export interface InvoicingSettings {
  provider: "" | "smartbill" | "demo";
  unitNames: Record<string, string>;
  shippingLabel: string;
  codFeeLabel: string;
  pointsDiscountLabel: string;
  serviceUnit: string;
  sendEmailByProvider: boolean;
  maxAttempts: number;
  alertAfterFailures: number;
  backoffMinutes: number[];
  leaseMinutes: number;
}

export async function readInvoicingSettings(db: Db): Promise<InvoicingSettings> {
  const rows = await db.setting.findMany({ where: { key: { startsWith: "invoicing." } } });
  const raw = new Map(rows.map((row) => [row.key.slice("invoicing.".length), row.value]));
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(settingGroups.invoicing)) {
    const parsed = schema.safeParse(raw.get(name));
    out[name] = parsed.success ? parsed.data : schema.parse(undefined);
  }
  return out as unknown as InvoicingSettings;
}

/** Cota standard de TVA, în puncte de bază, din setarea `tax.standardRate` (niciodată hardcodată). */
export async function readStandardRateBps(db: Db): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: "tax.standardRate" } });
  const parsed = settingGroups.tax.standardRate.safeParse(row?.value);
  const percent = parsed.success ? parsed.data : settingGroups.tax.standardRate.parse(undefined);
  return Math.round(percent * 100);
}
