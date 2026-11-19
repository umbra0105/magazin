/**
 * Interfața `PaymentProvider` (docs/05 §3, Faza 10) și tipurile ei. Stă în `packages/shared` ca să o poată importa și
 * adaptoarele (`packages/integrations`, care nu depinde de `core`), și logica de business (`packages/core`).
 *
 * Regulile interfeței:
 *  - sumele sunt bani ÎNTREGI (`amountMinor`); conversia în formatul procesatorului (zecimale) se face DOAR în adaptor, fără
 *    `float` în calcul;
 *  - NICIUN apel către procesator nu se face în afara unei implementări a acestei interfețe (test de arhitectură);
 *  - orice apel extern are timp limită explicit (cel mult `PAYMENT_CALL_TIMEOUT_MS`);
 *  - `verifyWebhook` primește corpul BRUT (octeții primiți) și refuză tot ce nu are semnătură validă: nu există cale fără
 *    semnătură. Un eveniment respins nu e crezut și nu are efecte;
 *  - secretele nu apar în erori, loguri sau `rawPayload`.
 */

export const PAYMENT_PROVIDER_CODES = ["netopia", "euplatesc", "demo"] as const;
export type PaymentProviderCode = (typeof PAYMENT_PROVIDER_CODES)[number];

/** `demo` e modul furnizorului fals; furnizorii reali sunt `test` sau `live`. */
export type PaymentMode = "test" | "live" | "demo";

/** Timpul maxim al oricărui apel extern către un procesator (docs/04 §8). */
export const PAYMENT_CALL_TIMEOUT_MS = 10_000;

export interface PaymentCustomer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  county: string;
  postalCode: string;
}

export interface CreatePaymentInput {
  /** Referința NOASTRĂ a plății (`Payment.id`): procesatorul o întoarce în notificări, iar noi o căutăm după ea. */
  paymentRef: string;
  orderNumber: string;
  amountMinor: number;
  currency: "RON";
  description: string;
  customer: PaymentCustomer;
  /** Unde trimite procesatorul clientul după plată (pagina noastră de retur: nu confirmă nimic). */
  returnUrl: string;
  /** Adresa de notificare server-la-server (webhook/IPN). */
  notifyUrl: string;
}

export interface PaymentRedirect {
  url: string;
  method: "GET" | "POST";
  /** Câmpuri de trimis prin formular când `method` e `POST`. */
  fields?: Record<string, string>;
}

export interface CreatePaymentResult {
  /** Referința procesatorului, dacă o dă deja la inițiere (Netopia: ntpID). */
  providerRef: string | null;
  redirect: PaymentRedirect;
}

/**
 * Rezultatul normalizat al unei notificări verificate.
 *  - `paid`: banii au fost luați (sau autorizați și capturați de procesator);
 *  - `failed`: refuzat, anulat de client, expirat, eroare; fără bani luați;
 *  - `pending`: stare intermediară (de exemplu autentificare 3DS necesară): NU e eșec și NU e anulare;
 *  - `credit`: rambursare/credit confirmat de procesator;
 *  - `unknown`: cod necunoscut: nu se ghicește, se înregistrează.
 */
export type PaymentOutcome = "paid" | "failed" | "pending" | "credit" | "unknown";

export interface PaymentEvent {
  /** Cheia de idempotență a evenimentului (unică per furnizor). Aceeași notificare retrimisă are același `eventId`. */
  eventId: string;
  /** Referința noastră, scrisă la inițiere (`CreatePaymentInput.paymentRef`). */
  paymentRef: string;
  providerRef: string | null;
  outcome: PaymentOutcome;
  /** Cod/stare brută de la procesator, doar pentru diagnostic (nu conține secrete). */
  rawStatus: string;
  /** Suma raportată de procesator, în bani; `null` dacă lipsește sau nu e un număr zecimal exact (fail-closed: «necesită atenție»). */
  amountMinor: number | null;
  currency: string | null;
  cardLast4: string | null;
}

export interface VerifiedWebhook {
  event: PaymentEvent;
  /** Ce răspuns cere procesatorul după înregistrare (EuPlătesc: text simplu `OK`). */
  response: { status: number; contentType: string; body: string };
}

export interface WebhookRequest {
  headers: Readonly<Record<string, string | undefined>>;
  /** Octeții primiți, neatinși (hash-ul/HMAC-ul se calculează pe ei). */
  rawBody: Buffer;
}

/** Motivele stabile ale respingerii unei notificări (se salvează în tabelul de evenimente, fără conținut). */
export const WEBHOOK_REJECT_REASONS = [
  "signature_missing",
  "signature_malformed",
  "signature_invalid",
  "algorithm_not_allowed",
  "issuer_invalid",
  "audience_invalid",
  "body_hash_mismatch",
  "body_invalid",
  "not_configured",
] as const;
export type WebhookRejectReason = (typeof WEBHOOK_REJECT_REASONS)[number];

/** Aruncată de `verifyWebhook` când notificarea nu poate fi crezută. Nu conține conținutul notificării. */
export class WebhookRejectedError extends Error {
  constructor(readonly reason: WebhookRejectReason) {
    super(`Notificare de plată respinsă: ${reason}`);
    this.name = "WebhookRejectedError";
  }
}

export interface RefundRequest {
  providerRef: string;
  paymentRef: string;
  /** Cheia de idempotență a rambursării (derivată din plată la cele automate). */
  refundRef: string;
  amountMinor: number;
  /** Suma totală a plății originale (unele API-uri cer și suma tranzacției). */
  paymentAmountMinor: number;
  currency: "RON";
  reason: string;
}

/**
 * Rezultatul unei cereri de rambursare. NU se presupune succesul:
 *  - `confirmed`: procesatorul a confirmat sincron;
 *  - `pending`: acceptată, confirmarea vine ulterior;
 *  - `failed`: refuzată de procesator (mesajul e fără secrete);
 *  - `manual_required`: operațiunea nu e disponibilă prin API (de exemplu «viitor» în specificația Netopia) sau a dat o
 *    eroare neprevăzută: se rambursează din contul procesatorului, apoi se confirmă manual.
 */
export type RefundOutcome =
  | { status: "confirmed"; providerRef: string | null }
  | { status: "pending"; providerRef: string | null }
  | { status: "failed"; message: string }
  | { status: "manual_required"; message: string };

export type CaptureOutcome = { status: "confirmed" } | { status: "unsupported"; message: string };

export interface ProviderStatus {
  outcome: PaymentOutcome;
  providerRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  rawStatus: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Mesaj clar, în română, fără secrete. */
  message: string;
}

export interface PaymentProvider {
  readonly code: PaymentProviderCode;
  readonly mode: PaymentMode;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Verifică semnătura și normalizează. Aruncă `WebhookRejectedError` dacă notificarea nu poate fi crezută. */
  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook>;
  capture(providerRef: string, amountMinor?: number): Promise<CaptureOutcome>;
  refund(request: RefundRequest): Promise<RefundOutcome>;
  /**
   * Starea tranzacției la procesator, sau `null` dacă furnizorul nu o poate da (Netopia: endpointul de status nu e
   * documentat; pagina de așteptare citește atunci doar starea din baza noastră).
   */
  getStatus(ref: {
    providerRef: string | null;
    paymentRef: string;
  }): Promise<ProviderStatus | null>;
  /** Apel inofensiv, fără efect financiar, cu timp limită. */
  testConnection(): Promise<ConnectionTestResult>;
}

/** Suma `bani` ca text zecimal cu 2 zecimale («12345» → «123.45»), fără `float`. */
export function minorToDecimalString(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError("Suma în bani nu e validă");
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

/**
 * Text zecimal exact («123.45», «123.4», «123») → bani; `null` dacă nu e exact (mai mult de 2 zecimale, semn, exponent,
 * spații). Fără `float`: se lucrează pe cifre.
 */
export function decimalStringToMinor(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const whole = Number(match[1]);
  const cents = match[2] === undefined ? 0 : Number(match[2].padEnd(2, "0"));
  return whole * 100 + cents;
}
