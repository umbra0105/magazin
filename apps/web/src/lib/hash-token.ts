/**
 * Tokenul dintr-un fragment de URL (`#token=…`). Linkurile din emailuri țin tokenul în fragment,
 * care nu ajunge niciodată la server (deci nici în loguri). Funcția e pură; pagina o apelează în
 * browser și apoi șterge fragmentul din adresă (`consumeHashToken`).
 */
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("token");
  return token && token.length >= 16 && token.length <= 512 ? token : null;
}

/** Citește tokenul din `location.hash` și scoate fragmentul din adresă (istoric, capturi de ecran). */
export function consumeHashToken(): string | null {
  const token = tokenFromHash(window.location.hash);
  if (window.location.hash) {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      // fără History API: tokenul rămâne în adresă, dar a fost deja citit
    }
  }
  return token;
}
