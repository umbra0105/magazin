/**
 * Utilitar DOAR pentru dezvoltare (nu face parte din produs): aplică un preset de temă.
 *
 *   pnpm dev:preset <minimal|bold|editorial> [--dark]
 *
 * `--dark` pornește paleta întunecată (după `prefers-color-scheme`). Trece prin
 * BrandingService.save (validare strictă, invalidare cache) și afișează avertismentele de contrast.
 */
import { Redis } from "ioredis";
import { BrandingService } from "../src/branding/branding-service";
import { configFromPreset } from "../src/branding/presets";
import { createPrismaBrandingStore } from "../src/branding/prisma-store";
import { PRESET_KEYS, type PresetKey } from "../src/branding/tokens";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const [presetArg, ...flags] = process.argv.slice(2);
const preset = PRESET_KEYS.find((key) => key === presetArg);
if (!preset) {
  console.error(`Folosire: pnpm dev:preset <${PRESET_KEYS.join("|")}> [--dark]`);
  process.exit(1);
}

const db = getDb();
const redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 1,
});
redis.on("error", () => undefined);

try {
  const service = new BrandingService(createPrismaBrandingStore(db), redis);
  const config = { ...configFromPreset(preset as PresetKey), darkMode: flags.includes("--dark") };
  const { warnings } = await service.save(config);
  console.log(`Preset aplicat: ${preset}${config.darkMode ? " (cu dark mode)" : ""}`);
  for (const w of warnings) {
    console.warn(
      `  ⚠ contrast ${w.mode} ${w.foreground}/${w.background}: ${w.ratio}:1 (minim ${w.required}:1)`,
    );
  }
} finally {
  redis.disconnect();
  await db.$disconnect();
}
