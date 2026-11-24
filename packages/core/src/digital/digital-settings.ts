import { z } from "zod";
import type { Db } from "../db-tx";
import { settingGroups } from "../settings/registry";

/**
 * Setările `digital.*` (Faza 14b), citite direct din baza de date cu valorile implicite din registru: le folosesc serviciile din
 * `packages/core` care nu primesc un `SettingsService` (cârlige din tranzacții, joburi). Valorile nevalide cad pe cele implicite
 * (o setare stricată nu trebuie să blocheze accesul unui client).
 */
const schema = z.object(settingGroups.digital);
export type DigitalSettings = z.infer<typeof schema>;

export async function readDigitalSettings(db: Db): Promise<DigitalSettings> {
  const rows = await db.setting.findMany({ where: { key: { startsWith: "digital." } } });
  const input: Record<string, unknown> = {};
  for (const row of rows) input[row.key.slice("digital.".length)] = row.value;
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  // câmp cu câmp: fiecare valoare nevalidă cade pe implicit, restul rămân
  const shape = settingGroups.digital as Record<string, z.ZodType>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const one = field.safeParse(input[key]);
    out[key] = one.success ? one.data : field.parse(undefined);
  }
  return schema.parse(out);
}
