import { createHash } from "node:crypto";
import { normalizeHostname } from "./host";

/**
 * Regulile unei adrese de imagine, FĂRĂ rețea (se folosesc și la verificarea importului, care nu face nicio
 * cerere, și la fiecare cerere și redirect din `safeFetchImage`): doar https, doar portul 443, fără utilizator
 * sau parolă, fără fragment, fără IP literal (în nicio formă: zecimal, octal, hex, IPv6), fără spații sau
 * caractere de control, lungime maximă, gazda în lista de domenii permise (potrivire EXACTĂ pe numele
 * normalizat; lista goală = nimic permis).
 */

export type ImageUrlRejection =
  | "too_long"
  | "invalid"
  | "scheme"
  | "credentials"
  | "port"
  | "fragment"
  | "ip_literal"
  | "no_hosts_configured"
  | "host_not_allowed";

export interface ImageUrlPolicy {
  allowedHosts: readonly string[];
  maxUrlLength: number;
}

export interface ParsedImageUrl {
  host: string;
  path: string;
  href: string;
  sourceHash: string;
}

export type ImageUrlCheck =
  ({ ok: true } & ParsedImageUrl) | { ok: false; reason: ImageUrlRejection; host: string | null };

/** Caractere de control, spații și bară oblică inversă: nu au ce căuta într-o adresă (URL le „repară” în tăcere). */
const FORBIDDEN_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}\\\\]`,
);
const NUMERIC_HOST = /^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+))*$/i;

/**
 * Regulile de SINTAXĂ ale adresei (https, port, utilizator, fragment, IP literal, lungime), fără lista de domenii.
 * Dă forma normalizată și hash-ul ei (cheia de idempotență a imaginilor aduse din adresă).
 */
export function parseImageUrl(
  raw: string,
  maxUrlLength: number,
): ({ ok: true } & ParsedImageUrl) | { ok: false; reason: ImageUrlRejection; host: string | null } {
  const reject = (reason: ImageUrlRejection, host: string | null = null): ImageUrlCheck => ({
    ok: false,
    reason,
    host,
  });
  if (raw.length > maxUrlLength) return reject("too_long");
  if (raw === "" || FORBIDDEN_CHARS.test(raw)) return reject("invalid");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("invalid");
  }
  if (url.protocol !== "https:") return reject("scheme");
  if (url.username !== "" || url.password !== "") return reject("credentials");
  // `URL` ascunde portul implicit al schemei: orice port rămas e diferit de 443
  if (url.port !== "") return reject("port");
  if (url.hash !== "") return reject("fragment");

  const hostname = url.hostname;
  // IPv6 între paranteze, IPv4 în orice formă (URL le canonizează la a.b.c.d) sau un singur număr
  if (hostname.startsWith("[") || NUMERIC_HOST.test(hostname)) return reject("ip_literal");
  const host = normalizeHostname(hostname);
  if (host === null) return reject("invalid");

  const path = `${url.pathname}${url.search}`;
  const href = `https://${host}${path}`;
  return {
    ok: true,
    host,
    path,
    href,
    sourceHash: createHash("sha256").update(href).digest("hex"),
  };
}

export function checkImageUrl(raw: string, policy: ImageUrlPolicy): ImageUrlCheck {
  const parsed = parseImageUrl(raw, policy.maxUrlLength);
  if (!parsed.ok) return parsed;
  if (policy.allowedHosts.length === 0)
    return { ok: false, reason: "no_hosts_configured", host: parsed.host };
  if (!policy.allowedHosts.includes(parsed.host))
    return { ok: false, reason: "host_not_allowed", host: parsed.host };
  return parsed;
}

/** Mesajul pentru administrator (în română, fără adrese complete, IP-uri sau detalii interne). */
export const IMAGE_URL_REJECTION_MESSAGES: Readonly<Record<ImageUrlRejection, string>> = {
  too_long: "adresă prea lungă",
  invalid: "adresă invalidă",
  scheme: "adresă respinsă (doar https)",
  credentials: "adresă respinsă (cu utilizator sau parolă)",
  port: "adresă respinsă (doar portul 443)",
  fragment: "adresă respinsă (cu fragment)",
  ip_literal: "adresă respinsă (IP în loc de domeniu)",
  no_hosts_configured: "nicio imagine nu se descarcă: lista de domenii permise e goală",
  host_not_allowed: "domeniu nepermis",
};

/** Împarte coloana «Imagini» din WooCommerce: adrese separate prin virgulă (și spațiu). */
export function splitImageCell(cell: string): string[] {
  return cell
    .split(/,\s*(?=[a-z][a-z0-9+.-]*:)/i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
