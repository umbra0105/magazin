import { cookies } from "next/headers";
import { CONSENT_COOKIE, parseConsent, type ConsentChoices } from "./consent";

/** Alegerea de consimțământ din cookie-ul cererii, sau `null` (nu există una valabilă: se aplică «refuzat» și se arată bannerul). */
export async function readConsent(): Promise<ConsentChoices | null> {
  return parseConsent((await cookies()).get(CONSENT_COOKIE)?.value);
}
