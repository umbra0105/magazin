/**
 * Specurile E2E care aplică un plan calculat pe TOT catalogul (import «stoc la zi», pornirea gestionării stocului): rulează
 * într-un proiect Playwright propriu, după proiectul principal, ca alte fișiere să nu schimbe catalogul între previzualizare
 * și aplicare. Motivul și regula: `test/architecture/e2e-global-state.architecture.test.ts`.
 */
export const GLOBAL_STATE_SPEC_FILES: readonly string[] = ["stock.spec.ts"];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Potrivește calea completă a unui fișier din listă (separator `/` sau `\`), nu și sufixe ca `.bak`. */
export const globalStateSpecPattern = new RegExp(
  `[\\\\/](?:${GLOBAL_STATE_SPEC_FILES.map(escape).join("|")})$`,
);
