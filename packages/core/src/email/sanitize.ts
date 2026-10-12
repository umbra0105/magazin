const MIN_SECRET_LENGTH = 4;

/**
 * Scoate dintr-un mesaj de eroare orice apariție a valorilor sensibile (token, link, adresa
 * destinatarului, corpul). Mesajele erorilor SMTP/HTTP pot repeta adresa sau o parte din conținut;
 * în loguri intră doar textul curățat. Caută și variantele codificate pentru URL.
 */
export function redactSecrets(
  message: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = message;
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    try {
      variants.add(decodeURIComponent(secret));
    } catch {
      // valoare cu % invalid: rămâne doar forma originală
    }
  }
  // Cele mai lungi întâi: un link conține tokenul, iar înlocuirea tokenului n-ar trebui să lase restul.
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(variant).join("[ascuns]");
  }
  return out;
}
