/**
 * Specurile E2E care aplică un plan calculat pe TOT catalogul (import «stoc la zi», pornirea gestionării stocului): rulează
 * într-un proiect Playwright propriu, după proiectul principal, ca alte fișiere să nu schimbe catalogul între previzualizare
 * și aplicare. Tot aici: `appearance-editor.spec.ts`, care schimbă setări comune întregii aplicații (tema, variantele de pagină,
 * modul de mentenanță, care face ca ORICE pagină a vitrinei să răspundă 503): alte specuri care vizitează vitrina nu au voie să ruleze
 * în paralel cu el. `cart-free-shipping.spec.ts` schimbă pragul de transport gratuit, vizibil în coșul oricărui client. Motivul și regula: `test/architecture/e2e-global-state.architecture.test.ts`.
 */
export const GLOBAL_STATE_SPEC_FILES: readonly string[] = [
  "stock.spec.ts",
  "appearance-editor.spec.ts",
  "cart-free-shipping.spec.ts",
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Potrivește calea completă a unui fișier din listă (separator `/` sau `\`), nu și sufixe ca `.bak`. */
export const globalStateSpecPattern = new RegExp(
  `[\\\\/](?:${GLOBAL_STATE_SPEC_FILES.map(escape).join("|")})$`,
);
