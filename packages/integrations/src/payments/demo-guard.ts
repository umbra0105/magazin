/**
 * Garda furnizorului DEMO (Faza 10). Furnizorul fals de plată există DOAR pentru dezvoltare și teste: nu poate fi activat într-o
 * instalare de producție. Un SINGUR loc decide, iar toate celelalte (registrul de furnizori, ecranul de setări, pagina de
 * plată demo, ruta webhook) îl apelează.
 *
 * Permis doar dacă:
 *  - `E2E_HARNESS=1` (marcajul suitei E2E, care rulează pe build de producție; nu există într-o instalare reală), SAU
 *  - `NODE_ENV` nu e `production` ȘI există flagul explicit de dezvoltare `ECOM_DEMO_PAYMENTS=1`.
 */
export interface DemoGuardEnv {
  NODE_ENV?: string | undefined;
  E2E_HARNESS?: string | undefined;
  ECOM_DEMO_PAYMENTS?: string | undefined;
}

export function isDemoPaymentAllowed(env: DemoGuardEnv): boolean {
  if (env.E2E_HARNESS === "1") return true;
  return env.NODE_ENV !== "production" && env.ECOM_DEMO_PAYMENTS === "1";
}
