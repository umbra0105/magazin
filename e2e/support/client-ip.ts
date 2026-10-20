import { randomBytes } from "node:crypto";

/**
 * Un IP de client propriu fiecărei înregistrări din testele E2E (trimis ca `X-Forwarded-For`).
 *
 * Suita E2E rulează cu `auth.trustedProxyHops = 1`, iar Next completează `X-Forwarded-For` cu IP-ul socketului când
 * lipsește: toate conturile create fără antet ar ajunge în același coș de limitare `register-ip:::1`, cu limita de 100
 * pe oră. O rulare curată creează exact 100 de conturi, deci orice reîncercare dă 429. Cu un IP propriu fiecare cont
 * are coșul lui (zona 10.0.0.0/8, nicio adresă reală; 24 de biți aleatori, ciocnirile sunt practic imposibile).
 */
export function uniqueClientIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}
