import { PRESETS, settingGroups } from "@ecom/core";
import { getLogger } from "@ecom/shared";
import { getBranding, getSettings } from "@/lib/services";

// Placeholder până la vitrină (Fazele 6-7). Citește numele magazinului din setări și arată
// tokenii temei, ca presetele să se vadă. Dinamic, pentru că depinde de setări/Branding.
export const dynamic = "force-dynamic";

async function loadPageData() {
  try {
    const [storeName, branding] = await Promise.all([
      getSettings().get("general.storeName"),
      getBranding().getConfig(),
    ]);
    return { storeName, preset: PRESETS[branding.preset].label, darkMode: branding.darkMode };
  } catch (error) {
    // Fără DB/Redis pagina rămâne afișabilă, cu numele implicit din registru.
    getLogger().warn({ err: error }, "nu pot citi setările pentru pagina principală");
    return {
      storeName: settingGroups.general.storeName.parse(undefined),
      preset: null,
      darkMode: false,
    };
  }
}

export default async function HomePage() {
  const { storeName, preset, darkMode } = await loadPageData();

  return (
    <main className="mx-auto max-w-(--container-width) space-y-6 p-8">
      <h1 className="font-[family-name:var(--font-heading)] text-4xl font-semibold">{storeName}</h1>
      <p className="text-muted-foreground">
        Text în fontul de corp, culoarea secundară.
        {preset ? ` Preset: ${preset}${darkMode ? ", cu dark mode" : ""}.` : null}
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-md bg-primary px-3 py-1 text-primary-foreground">primary</span>
        <span className="rounded-md border border-border px-3 py-1 text-accent">accent</span>
        <span className="rounded-md border border-border px-3 py-1 text-success">success</span>
        <span className="rounded-md border border-border px-3 py-1 text-danger">danger</span>
        <span className="rounded-md border border-border px-3 py-1">border</span>
      </div>
    </main>
  );
}
