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
  return parts[parts.length - hops] ?? null;
}
