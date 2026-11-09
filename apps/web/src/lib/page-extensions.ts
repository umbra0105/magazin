/**
 * Extensiile pe care Next le tratează ca pagini/rute (`pageExtensions` din next.config.ts). Fișierele `*.e2e.tsx` (harness-uri
 * pentru teste și pagina de exemplu a componentelor din docs/17 §7) sunt rute doar în dezvoltare sau cu `E2E_HARNESS=1`
 * (build-ul de test al Playwright); într-un build de producție obișnuit nu sunt nici rute, nici compilate. Funcție pură, ca să
 * se poată testa (nu citește `process.env` direct).
 */
export function pageExtensionsFor(env: {
  NODE_ENV?: string | undefined;
  E2E_HARNESS?: string | undefined;
}): string[] {
  const base = ["tsx", "ts", "jsx", "js"];
  const devOnly = env.NODE_ENV === "development" || env.E2E_HARNESS === "1";
  return devOnly ? [...base, "e2e.tsx"] : base;
}
