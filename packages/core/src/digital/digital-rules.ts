import { createHash, randomBytes } from "node:crypto";

/**
 * Regulile pure ale produselor digitale (Faza 14b): CÂND se acordă accesul (decizia 1), când se retrage, cum arată jetonul de acces,
 * când o folosire a unui drept de acces e suspectă și ce text are bifa legală. Fără bază de date, fără ceas, fără efecte: tot ce
 * hotărăște accesul stă aici, ca să se poată testa exhaustiv și ca nicio altă cale să nu-l hotărască altfel.
 */

export type DigitalPaymentMethod = "cod" | "bank_transfer" | "card";

export interface GrantFacts {
  paymentMethod: DigitalPaymentMethod;
  paymentStatus: string;
  status: string;
  fulfillmentStatus: string;
  /** Comanda are cel puțin o linie digitală. */
  hasDigital: boolean;
  /** Comanda are cel puțin o linie fizică (comandă mixtă). */
  hasPhysical: boolean;
}

export type GrantReason = "payment" | "delivery";

export type GrantDecision = { grant: false } | { grant: true; reason: GrantReason };

/** Stările de comandă din care nu se mai acordă niciun acces (comanda s-a încheiat fără livrare). */
const DEAD_ORDER_STATUSES: ReadonlySet<string> = new Set(["cancelled", "returned"]);
/** Stările de plată care exclud accesul: banii nu există sau s-au întors. */
const DEAD_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "refunded",
  "chargeback",
]);

/**
 * Decizia 1 (utilizator, 2026-11-23):
 *  - card: la plata confirmată (`paid`);
 *  - transfer bancar: la «Marchează plătit» (`paid`);
 *  - ramburs (doar comenzi mixte; 100% digital nu poate avea ramburs): la LIVRARE CONFIRMATĂ (`fulfillmentStatus = delivered`),
 *    NU la virarea banilor de către curier și nu la expediere.
 * Nicio comandă anulată, returnată, eșuată sau rambursată integral nu primește acces.
 */
export function decideGrant(facts: GrantFacts): GrantDecision {
  if (!facts.hasDigital) return { grant: false };
  if (DEAD_ORDER_STATUSES.has(facts.status) || DEAD_PAYMENT_STATUSES.has(facts.paymentStatus)) {
    return { grant: false };
  }
  if (facts.paymentMethod === "cod") {
    if (!facts.hasPhysical) return { grant: false };
    return facts.fulfillmentStatus === "delivered"
      ? { grant: true, reason: "delivery" }
      : { grant: false };
  }
  return facts.paymentStatus === "paid" || facts.paymentStatus === "partially_refunded"
    ? { grant: true, reason: "payment" }
    : { grant: false };
}

/**
 * Când se retrage accesul de pe TOATĂ comanda: motivul (scris în drept și în jurnal) sau `null`. O rambursare PARȚIALĂ nu retrage
 * nimic de la sine: revocarea pe linie se face doar la rambursarea liniei respective (cheia de idempotență a rambursării) sau
 * manual, de admin.
 */
export function decideRevocation(facts: { paymentStatus: string; status: string }): string | null {
  if (facts.paymentStatus === "refunded") return "Comanda a fost rambursată integral";
  if (facts.paymentStatus === "chargeback") return "Plata a fost contestată (chargeback)";
  if (facts.status === "cancelled") return "Comanda a fost anulată";
  return null;
}

// ------------------------------------------------------------------------------------------------------------------- jeton

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** Jeton opac (256 de biți, URL-safe): identificatorul din adrese; nu înlocuiește verificarea proprietarului. */
export function generateAccessToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

export function isValidAccessToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

// ----------------------------------------------------------------------------------------------------- tipar anormal (IP)

export function distinctIpCount(ips: ReadonlyArray<string | null>): number {
  return new Set(ips.filter((ip): ip is string => ip !== null && ip !== "")).size;
}

/** Alertă când numărul de adrese IP distincte DEPĂȘEȘTE pragul (strict). */
export function isIpAnomaly(ips: ReadonlyArray<string | null>, maxIps: number): boolean {
  return distinctIpCount(ips) > maxIps;
}

// -------------------------------------------------------------------------------------------------------------- bifa legală

/**
 * Textul implicit al bifei (`docs/11` §5; formularea finală cu avocatul, `INTREBARI-AVOCAT` 5.2). Separat de acceptarea Termenilor,
 * nepre-bifat, obligatoriu. Se salvează pe comandă împreună cu momentul și versiunea.
 */
export const DIGITAL_CONSENT_DEFAULT_TEXT =
  "Solicit livrarea imediată a conținutului digital și confirm că îmi pierd dreptul de retragere de 14 zile după începerea livrării.";
export const DIGITAL_CONSENT_DEFAULT_VERSION = "provizoriu-1";

export interface ConsentSnapshot {
  text: string;
  version: string;
}

/**
 * Textul și versiunea care se arată și se salvează: textul din setare (dacă e completat) cu o versiune derivată din conținut,
 * altfel textul implicit. Alt text înseamnă altă versiune, deci o comandă veche păstrează textul pe care l-a acceptat clientul.
 */
export function consentSnapshot(configuredText: string): ConsentSnapshot {
  const text = configuredText.trim();
  if (text === "") {
    return { text: DIGITAL_CONSENT_DEFAULT_TEXT, version: DIGITAL_CONSENT_DEFAULT_VERSION };
  }
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 10);
  return { text, version: `text-${digest}` };
}
