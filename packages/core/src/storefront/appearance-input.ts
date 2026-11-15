import { z } from "zod";
import { brandingConfigSchema } from "../branding/tokens";
import { settingGroups } from "../settings/registry";

/**
 * Ce trimite editorul de temă (Nivel 2) la salvare: tema (`Branding`, validată strict, inclusiv CSS-ul personalizat) și
 * setările de aspect (`appearance.*`, cu aceleași reguli ca registrul de setări). Orice altă cheie se respinge: formularul nu
 * poate scrie alte setări. Schema e singurul loc de validare; acțiunea de pe server o aplică, interfața doar afișează erorile.
 */
export const appearanceInputSchema = z.strictObject({
  branding: brandingConfigSchema,
  settings: z.strictObject(settingGroups.appearance),
});
export type AppearanceInput = z.input<typeof appearanceInputSchema>;
export type AppearanceValues = z.output<typeof appearanceInputSchema>;

/** Prima eroare a fiecărui câmp, cu calea separată prin punct (`branding.colors.light.bg`): ce afișează formularul sub câmp. */
export function issuesByField(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
