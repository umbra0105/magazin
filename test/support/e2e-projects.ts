/**
 * Specurile E2E care aplică un plan calculat pe TOT catalogul (import «stoc la zi», pornirea gestionării stocului): rulează
 * într-un proiect Playwright propriu, după proiectul principal, ca alte fișiere să nu schimbe catalogul între previzualizare
 * și aplicare. Tot aici: `appearance-editor.spec.ts`, care schimbă setări comune întregii aplicații (tema, variantele de pagină,
 * modul de mentenanță, care face ca ORICE pagină a vitrinei să răspundă 503): alte specuri care vizitează vitrina nu au voie să ruleze
 * în paralel cu el. `cart-free-shipping.spec.ts` schimbă pragul de transport gratuit, vizibil în coșul oricărui client.
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

/**
 * Fluxurile de comenzi și de oferte din admin (Faza 11): lucrează cu LISTELE comune de comenzi și de oferte și cu curățarea globală
 * a comenzilor E2E (`removeE2eOrders`), deci rulează într-un proiect propriu, după toate celelalte, într-un singur fișier (serial):
 * în paralel cu alte specuri, o comandă în lucru ar putea fi ștearsă de curățarea altui fișier, iar specurile cu plan pe tot
 * catalogul mută stocul tuturor variantelor.
 *
 * Tot aici `loyalty.spec.ts` (Faza 15b): pornește flag-ul `loyalty` și setările programului, comune întregii aplicații (elemente
 * noi în meniul de admin, pe pagina produsului și în checkout), deci nu poate sta în proiectul principal (de exemplu `admin.spec.ts`
 * afirmă că meniul nu are punctele cu flag-ul oprit). Își șterge și el doar comenzile lui, pe tag.
 */
export const ORDER_FLOW_SPEC_FILES: readonly string[] = [
  "orders-offers.spec.ts",
  "loyalty.spec.ts",
];

export const orderFlowSpecPattern = new RegExp(
  `[\\\\/](?:${ORDER_FLOW_SPEC_FILES.map(escape).join("|")})$`,
);
