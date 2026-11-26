import type { Db } from "../db-tx";

/**
 * Programul de puncte al ACESTUI magazin (`db:seed:store`, Faza 15b): flag-ul `loyalty` pornit, programul activ și tratamentul
 * TVA `base_reduced`. Se aplică O SINGURĂ DATĂ, cât timp `loyalty.enabled` n-a fost salvat niciodată: ce schimbă apoi adminul
 * (program oprit, tratament golit, flag oprit) nu se suprascrie. Pachetul rămâne cu programul oprit și tratamentul gol.
 */
export async function seedStoreLoyalty(db: Db): Promise<boolean> {
  const touched = await db.setting.findUnique({
    where: { key: "loyalty.enabled" },
    select: { key: true },
  });
  if (touched) return false;
  await db.featureFlag.upsert({
    where: { key: "loyalty" },
    create: { key: "loyalty", enabled: true },
    update: { enabled: true },
  });
  for (const [name, value] of [
    ["vatMode", "base_reduced"],
    ["enabled", true],
  ] as const) {
    const key = `loyalty.${name}`;
    await db.setting.upsert({
      where: { key },
      create: { key, group: "loyalty", value },
      update: { value },
    });
  }
  return true;
}
