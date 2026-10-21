import { isIP } from "node:net";

/**
 * Cheia de limitare pentru o adresă IP: IPv4 rămâne cum e; IPv6 se cheamă pe /64 (un client are de obicei un /64 întreg,
 * deci schimbarea adresei în interiorul lui nu trebuie să ocolească limitele); IPv6 mapat pe IPv4 devine IPv4. Un șir
 * care nu e adresă IP nu devine cheie (`null`): în chei nu intră text arbitrar de la client.
 */
export function ipKey(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 45) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return isIP(mapped[1] as string) === 4 ? (mapped[1] as string) : null;
  const groups = expandIpv6(value);
  if (!groups) return null;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Primele grupe ale unei adrese IPv6, în litere mici, fără zerouri la început; `null` dacă forma e invalidă. */
function expandIpv6(address: string): string[] | null {
  const noZone = address.split("%")[0] as string;
  const [head, tail, ...extra] = noZone.split("::");
  if (extra.length > 0) return null;
  const toGroups = (part: string | undefined): string[] => (part ? part.split(":") : []);
  const first = toGroups(head);
  const last = toGroups(tail);
  const missing = 8 - first.length - last.length;
  const groups =
    tail === undefined
      ? first
      : [...first, ...Array<string>(Math.max(missing, 0)).fill("0"), ...last];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""));
}

/**
 * IP-ul clientului. `X-Forwarded-For` poate fi scris de orice client, deci se citește doar când
 * știm câte proxy-uri de încredere sunt în față (`hops`): fiecare proxy adaugă adresa de la care
 * a primit cererea la SFÂRȘITUL listei, deci adresa de încredere e a `hops`-a de la dreapta.
 * Cu `hops = 0` nu citim niciun header și întoarcem `null` (limitele rămân pe email).
 */
export function resolveClientIp(headers: Headers | undefined, hops: number): string | null {
  if (!headers || hops <= 0) return null;
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Mai puține adrese decât proxy-uri așteptate = header lipsă sau falsificat: nu avem IP de încredere.
  if (parts.length < hops) return null;
  const raw = parts[parts.length - hops];
  return raw ? ipKey(raw) : null;
}
