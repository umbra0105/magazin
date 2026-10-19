import { isIP } from "node:net";

/**
 * Verifică dacă o adresă IP este PUBLICĂ (rutabilă pe internet). Orice altceva se refuză la descărcarea
 * imaginilor: loopback, rețele private, link-local (inclusiv 169.254.169.254, metadata cloud), CGNAT
 * 100.64/10, 0.0.0.0/8, multicast, rezervate, de documentare și de tranziție (NAT64, 6to4, Teredo),
 * IPv6 unique-local / link-local / loopback și IPv4-mapped IPv6. Principiu: DOAR ce e dovedit public
 * trece (IPv4: tot ce nu e în lista de intervale speciale; IPv6: doar unicast global 2000::/3 fără
 * intervalele speciale din el). Lista de domenii permise NU anulează această verificare.
 */

type Range4 = readonly [base: string, bits: number];

/** Intervale IPv4 nepublice (IANA special-purpose address registry + multicast/rezervate). */
const BLOCKED_V4: readonly Range4[] = [
  ["0.0.0.0", 8], // „această rețea”
  ["10.0.0.0", 8], // privat
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (inclusiv 169.254.169.254, metadata cloud)
  ["172.16.0.0", 12], // privat
  ["192.0.0.0", 24], // protocoale IETF
  ["192.0.2.0", 24], // documentare (TEST-NET-1)
  ["192.88.99.0", 24], // 6to4 relay (depășit)
  ["192.168.0.0", 16], // privat
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // documentare (TEST-NET-2)
  ["203.0.113.0", 24], // documentare (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // rezervat (inclusiv 255.255.255.255)
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const inRange4 = (value: number, [base, bits]: Range4): boolean => {
  const start = ipv4ToInt(base) as number;
  const size = 2 ** (32 - bits);
  return value >= start && value < start + size;
};

export function isPublicIPv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  return !BLOCKED_V4.some((range) => inRange4(value, range));
}

/** Cele 8 grupe de 16 biți ale unei adrese IPv6 (cu `::` și IPv4 încorporat), sau `null` dacă nu e validă. */
function parseIPv6(address: string): number[] | null {
  if (address.includes("%")) return null; // zona (fe80::1%eth0) nu are ce căuta într-o adresă DNS
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = ipv4ToInt(tail);
    if (embedded === null) return null;
    const high = Math.floor(embedded / 65536).toString(16);
    const low = (embedded % 65536).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const doubles = text.split("::");
  if (doubles.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = toGroups(doubles[0] as string);
  if (head === null) return null;
  if (doubles.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(doubles[1] as string);
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

const prefixMatches = (
  groups: readonly number[],
  base: readonly number[],
  bits: number,
): boolean => {
  let remaining = bits;
  for (let i = 0; i < base.length && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] as number) & mask) !== ((base[i] as number) & mask)) return false;
    remaining -= take;
  }
  return true;
};

/** Intervale IPv6 speciale ÎN INTERIORUL unicastului global 2000::/3 (sau care ar putea păcăli verificarea). */
const BLOCKED_V6: readonly (readonly [number[], number])[] = [
  [[0x2001, 0x0000], 23], // protocoale IETF (Teredo 2001::/32, benchmark, ORCHID...)
  [[0x2001, 0x0db8], 32], // documentare
  [[0x2002], 16], // 6to4
  [[0x3fff], 20], // documentare (RFC 9637)
  [[0x5f00], 8], // SRv6 SIDs (rezervat)
];

export function isPublicIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (groups === null) return false;
  // tot ce nu e unicast global (2000::/3) cade: ::, ::1, ::ffff:0:0/96 (IPv4-mapped), ::/96 (IPv4-compatible),
  // 64:ff9b::/96 (NAT64), 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8...
  const first = groups[0] as number;
  if (first < 0x2000 || first > 0x3fff) return false;
  return !BLOCKED_V6.some(([base, bits]) => prefixMatches(groups, base, bits));
}

/** Adresa (v4 sau v6, în orice formă canonică returnată de DNS) este publică? Orice altceva → fals. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}
