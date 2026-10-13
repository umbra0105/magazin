/**
 * Cererile care schimbă date și se autentifică prin cookie trebuie să vină de la propria aplicație
 * (apărare împotriva CSRF, peste `SameSite`). Browserele trimit `Origin` la orice `POST`
 * cross-origin și la `fetch`-urile same-origin cu corp; o cerere fără `Origin` nu e a unui
 * formular al aplicației și se refuză.
 */
export function isSameOriginRequest(headers: Headers, appUrl: string): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  let allowed: string;
  try {
    allowed = new URL(appUrl).origin;
  } catch {
    return false;
  }
  if (origin !== allowed) return false;
  // Defensă suplimentară: dacă browserul o declară, cererea trebuie să fie din aceeași origine.
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}
