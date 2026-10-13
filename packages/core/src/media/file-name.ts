const MAX_LENGTH = 150;
const FALLBACK = "imagine";

/**
 * Numele afișat în bibliotecă. E doar informativ: nu intră niciodată într-un URL sau într-o cheie
 * de storage. Se decodează din percent-encoding (headerul `X-File-Name`), se scot căile,
 * caracterele de control și cele rezervate, apoi se limitează lungimea.
 */
export function sanitizeFileName(raw: string | null | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // percent-encoding invalid: folosim valoarea ca atare
  }
  name = name
    .normalize("NFC")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex -- scoatem caracterele de control din nume
    .replace(/[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (name.length > MAX_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, MAX_LENGTH - ext.length) + ext;
  }
  return name === "" ? FALLBACK : name;
}
