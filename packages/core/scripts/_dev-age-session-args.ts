import { z } from "zod";

export type AgeSessionArgs =
  { ok: true; email: string; hours: number } | { ok: false; message: string };

const USAGE = "Folosire: pnpm dev:age-session <email> <ore>   (doar pentru dezvoltare)";

/**
 * Argumentele și garda comenzii `dev:age-session`. Refuză în producție (NODE_ENV=production sau
 * APP_ENV=production) fără nicio cale de a o ocoli din argumente.
 */
export function parseAgeSessionArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AgeSessionArgs {
  if (env["NODE_ENV"] === "production" || env["APP_ENV"] === "production") {
    return {
      ok: false,
      message: "dev:age-session e doar pentru dezvoltare și refuză în producție.",
    };
  }
  const [rawEmail, rawHours, ...rest] = argv;
  if (!rawEmail || !rawHours || rest.length > 0) return { ok: false, message: USAGE };
  const email = rawEmail.trim().toLowerCase();
  if (!z.email().safeParse(email).success) return { ok: false, message: `Email invalid. ${USAGE}` };
  const hours = Number(rawHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
    return { ok: false, message: `Orele trebuie să fie un număr între 0 și 8760. ${USAGE}` };
  }
  return { ok: true, email, hours };
}
