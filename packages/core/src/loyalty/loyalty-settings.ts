import type { Db } from "../db-tx";
import { getSettingSchema, type SettingGroupValue } from "../settings/registry";

/**
 * Setările de loialitate, citite direct din bază (fără cache), ca regulile de bani să vadă mereu ce e salvat. Programul e ACTIV
 * doar cu flag-ul `loyalty` pornit ȘI cu `loyalty.enabled`; punctele se pot FOLOSI doar când și `loyalty.vatMode` e setat. O
 * valoare lipsă sau stricată cade pe cea implicită din registru; implicitul lui `vatMode` e gol, deci blochează folosirea.
 */
export type LoyaltySettings = SettingGroupValue<"loyalty"> & {
  featureOn: boolean;
  active: boolean;
  redeemAvailable: boolean;
};

const NAMES = [
  "enabled",
  "earnRate",
  "pointValue",
  "expiryMonths",
  "expiryWarningDays",
  "maxRedeemPercent",
  "minRedeemPoints",
  "minCashAmount",
  "earnOnDiscountedItems",
  "vatMode",
  "releasedGraceDays",
] as const;

export function loyaltySettingsFrom(
  rows: ReadonlyMap<string, unknown>,
  featureOn: boolean,
): LoyaltySettings {
  const values = Object.fromEntries(
    NAMES.map((name) => {
      const key = `loyalty.${name}`;
      const schema = getSettingSchema(key)!;
      const parsed = rows.has(key) ? schema.safeParse(rows.get(key)) : null;
      return [name, parsed?.success ? parsed.data : schema.parse(undefined)];
    }),
  ) as SettingGroupValue<"loyalty">;
  const active = featureOn && values.enabled;
  return { ...values, featureOn, active, redeemAvailable: active && values.vatMode !== null };
}

export async function readLoyaltySettings(db: Db): Promise<LoyaltySettings> {
  const [rows, flag] = await Promise.all([
    db.setting.findMany({ where: { group: "loyalty" }, select: { key: true, value: true } }),
    db.featureFlag.findUnique({ where: { key: "loyalty" }, select: { enabled: true } }),
  ]);
  return loyaltySettingsFrom(
    new Map(rows.map((row) => [row.key, row.value])),
    flag?.enabled === true,
  );
}
