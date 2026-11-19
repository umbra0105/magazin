import {
  IntegrationError,
  WebhookRejectedError,
  minorToDecimalString,
  type CaptureOutcome,
  type ConnectionTestResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentMode,
  type PaymentOutcome,
  type PaymentProvider,
  type ProviderStatus,
  type RefundOutcome,
  type RefundRequest,
  type VerifiedWebhook,
  type WebhookRequest,
  decimalStringToMinor,
} from "@ecom/shared";
import { callProcessor, isRecord, parseJson, safeSnippet, type FetchLike } from "./http";
import { parsePublicKey, sha256Hex, verifyNetopiaIpn } from "./netopia-ipn";

/**
 * Adaptorul Netopia Payments API v2 (JSON, cheia API în antetul `Authorization`).
 *
 * ⚠️ NECONFIRMAT, DE VERIFICAT CU SANDBOX REAL (față de documentația oficială citită la 2026-11-19):
 *  - semnătura IPN (vezi `netopia-ipn.ts`): documentația v2 nu o descrie; schema vine dintr-un proiect existent;
 *  - răspunsul pe care îl așteaptă Netopia la IPN (aici JSON `errorType`/`errorCode`/`errorMessage` cu 200);
 *  - forma exactă a cererii și a răspunsului `start` (câmpul `payment.paymentURL`), unitatea sumei din IPN;
 *  - statusurile: 3 și 5 = plătit; 15 = autentificare 3DS necesară (INTERMEDIAR); 4, 11, 12, 23 = eșec; 8 = credit;
 *  - rambursarea: `/operation/credit` există în specificația OpenAPI, dar e marcată «will be available at a future date»;
 *    orice eroare sau răspuns neașteptat => «manuală necesară», niciodată succes presupus;
 *  - endpointul de status NU e în specificația oficială: `getStatus` întoarce `null` (nu se folosește).
 */

export const NETOPIA_BASE_URLS = {
  test: "https://secure.sandbox.netopia-payments.com",
  live: "https://secure.mobilpay.ro/pay",
} as const;

export interface NetopiaCredentials {
  apiKey: string;
  posSignature: string;
  /** Cheia publică RSA Netopia (PEM sau doar corpul base64), pentru verificarea IPN. */
  publicKey: string;
}

export interface NetopiaOptions {
  credentials: NetopiaCredentials;
  mode: Exclude<PaymentMode, "demo">;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Statusurile Netopia v2 (⚠️ neconfirmat). */
export function netopiaOutcome(status: number): PaymentOutcome {
  if (status === 3 || status === 5) return "paid";
  if (status === 15) return "pending";
  if (status === 4 || status === 11 || status === 12 || status === 23) return "failed";
  if (status === 8) return "credit";
  return "unknown";
}

type SourceReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

/** Citește corpul IPN și păstrează textul exact al sumei (ca să nu treacă prin `float`). */
function parseIpnBody(
  raw: Buffer,
): { json: Record<string, unknown>; amountText: string | null } | null {
  let amountText: string | null = null;
  const reviver: SourceReviver = function (key, value, context) {
    // doar suma din obiectul «payment» (cel care are și ntpID)
    const holder = this as Record<string, unknown> | null;
    if (
      key === "amount" &&
      holder &&
      typeof value === "number" &&
      typeof context?.source === "string" &&
      holder["ntpID"] !== undefined
    ) {
      amountText = context.source;
    }
    return value;
  };
  try {
    const json: unknown = JSON.parse(
      raw.toString("utf8"),
      reviver as unknown as (this: unknown, key: string, value: unknown) => unknown,
    );
    return isRecord(json) ? { json, amountText } : null;
  } catch {
    return null;
  }
}

export class NetopiaProvider implements PaymentProvider {
  readonly code = "netopia" as const;
  readonly mode: PaymentMode;
  private readonly creds: NetopiaCredentials;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;

  constructor(options: NetopiaOptions) {
    this.creds = options.credentials;
    this.mode = options.mode;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? (() => new Date());
  }

  private get baseUrl(): string {
    return this.mode === "live" ? NETOPIA_BASE_URLS.live : NETOPIA_BASE_URLS.test;
  }

  private assertConfigured(): void {
    if (
      !this.creds.apiKey.trim() ||
      !this.creds.posSignature.trim() ||
      !parsePublicKey(this.creds.publicKey)
    ) {
      throw new IntegrationError(
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "Netopia nu este configurat: cheia API, semnătura POS sau cheia publică lipsesc ori nu sunt valide",
      );
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.assertConfigured();
    const c = input.customer;
    const payload = {
      config: {
        emailTemplate: "default",
        notifyUrl: input.notifyUrl,
        redirectUrl: input.returnUrl,
        language: "ro",
      },
      payment: {
        options: { installments: 0, bonus: 0 },
        instrument: { type: "card", account: "", expMonth: 0, expYear: 0, secretCode: "" },
        data: {},
      },
      order: {
        ntpID: "",
        posSignature: this.creds.posSignature,
        dateTime: this.now().toISOString(),
        description: input.description,
        orderID: input.paymentRef,
        // suma în unități zecimale; textul exact trece prin `Number` doar la serializare (cel mult 2 zecimale)
        amount: Number(minorToDecimalString(input.amountMinor)),
        currency: input.currency,
        billing: {
          email: c.email,
          phone: c.phone,
          firstName: c.firstName,
          lastName: c.lastName,
          city: c.city,
          country: 642,
          state: c.county,
          postalCode: c.postalCode,
          details: c.street,
        },
      },
    };
    const result = await callProcessor(this.fetchImpl, `${this.baseUrl}/payment/card/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.creds.apiKey },
      body: JSON.stringify(payload),
    });
    const json = parseJson(result.text);
    if (!result.ok) {
      throw new IntegrationError(
        "PAYMENT_PROVIDER_REJECTED",
        `Netopia a refuzat inițierea plății (cod HTTP ${result.status})`,
      );
    }
    if (!isRecord(json)) {
      throw new IntegrationError(
        "PAYMENT_PROVIDER_BAD_RESPONSE",
        "Răspuns neașteptat de la Netopia la inițierea plății",
      );
    }
    const payment = isRecord(json["payment"]) ? json["payment"] : {};
    const error = isRecord(json["error"]) ? json["error"] : {};
    const code = typeof error["code"] === "string" ? error["code"] : "";
    const url = typeof payment["paymentURL"] === "string" ? payment["paymentURL"] : "";
    let parsed: URL | null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new IntegrationError(
        "PAYMENT_PROVIDER_BAD_RESPONSE",
        `Răspuns neașteptat de la Netopia la inițierea plății${code ? ` (cod ${safeSnippet(code, 10)})` : ""}`,
      );
    }
    const ntpId = payment["ntpID"];
    return {
      providerRef: typeof ntpId === "string" || typeof ntpId === "number" ? String(ntpId) : null,
      redirect: { url: parsed.toString(), method: "GET" },
    };
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    verifyNetopiaIpn(request.rawBody, request.headers["verification-token"], {
      publicKey: this.creds.publicKey,
      posSignatures: [this.creds.posSignature],
      nowSeconds: Math.floor(this.now().getTime() / 1000),
    });
    // semnătura e validă: corpul poate fi citit
    const parsed = parseIpnBody(request.rawBody);
    if (!parsed) throw new WebhookRejectedError("body_invalid");
    const payment = isRecord(parsed.json["payment"]) ? parsed.json["payment"] : null;
    const order = isRecord(parsed.json["order"]) ? parsed.json["order"] : null;
    const orderId = order?.["orderID"];
    const status = payment?.["status"];
    if (!payment || typeof orderId !== "string" || orderId === "" || typeof status !== "number") {
      throw new WebhookRejectedError("body_invalid");
    }
    const ntpId = payment["ntpID"];
    const currency = payment["currency"];
    const instrument = isRecord(payment["instrument"]) ? payment["instrument"] : {};
    const account = typeof instrument["account"] === "string" ? instrument["account"] : "";
    // doar un număr de card MASCAT; ultimele 4 cifre, nimic altceva
    const last4 = /[*xX•]/.test(account) ? (/(\d{4})\D*$/.exec(account)?.[1] ?? null) : null;
    return {
      event: {
        eventId: sha256Hex(request.rawBody),
        paymentRef: orderId,
        providerRef: typeof ntpId === "string" || typeof ntpId === "number" ? String(ntpId) : null,
        outcome: netopiaOutcome(status),
        rawStatus: `status=${status}`,
        amountMinor: parsed.amountText === null ? null : decimalStringToMinor(parsed.amountText),
        currency: typeof currency === "string" ? currency : null,
        cardLast4: last4,
      },
      response: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ errorType: 0, errorCode: 0, errorMessage: "OK" }),
      },
    };
  }

  async capture(): Promise<CaptureOutcome> {
    return {
      status: "unsupported",
      message: "Netopia nu are captură manuală disponibilă în API-ul v2 documentat.",
    };
  }

  async refund(request: RefundRequest): Promise<RefundOutcome> {
    const manual = (message: string): RefundOutcome => ({ status: "manual_required", message });
    if (!this.creds.apiKey.trim()) {
      return manual(
        "Cheia API Netopia lipsește: rambursează din contul Netopia, apoi confirmă manual.",
      );
    }
    try {
      const result = await callProcessor(this.fetchImpl, `${this.baseUrl}/operation/credit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.creds.apiKey },
        body: JSON.stringify({
          ntpID: request.providerRef,
          amount: Number(minorToDecimalString(request.amountMinor)),
        }),
      });
      const json = parseJson(result.text);
      const error = isRecord(json) && isRecord(json["error"]) ? json["error"] : null;
      const payment = isRecord(json) && isRecord(json["payment"]) ? json["payment"] : null;
      const okCode = error !== null && (error["code"] === "00" || error["code"] === "0");
      if (result.ok && okCode) {
        const ref = payment?.["ntpID"];
        const providerRef = typeof ref === "string" || typeof ref === "number" ? String(ref) : null;
        // confirmat doar dacă procesatorul spune explicit «credit» (status 8); altfel rămâne în așteptare
        return payment?.["status"] === 8
          ? { status: "confirmed", providerRef }
          : { status: "pending", providerRef };
      }
      return manual(
        "Netopia nu a acceptat rambursarea prin API (operațiunea poate să nu fie încă disponibilă): rambursează din contul Netopia, apoi confirmă manual.",
      );
    } catch {
      return manual(
        "Netopia nu a răspuns clar: verifică în contul Netopia dacă rambursarea a fost făcută înainte de a o repeta, apoi confirmă manual.",
      );
    }
  }

  async getStatus(): Promise<ProviderStatus | null> {
    // Endpointul de status nu e în specificația oficială citită: nu se folosește (pagina de așteptare citește doar starea din baza noastră).
    return null;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const problems: string[] = [];
    if (!this.creds.apiKey.trim()) problems.push("cheia API lipsește");
    if (!this.creds.posSignature.trim()) problems.push("semnătura POS lipsește");
    if (!parsePublicKey(this.creds.publicKey)) {
      problems.push("cheia publică nu e o cheie RSA validă (PEM sau certificat)");
    }
    if (problems.length > 0) {
      return { ok: false, message: `Date incomplete: ${problems.join("; ")}.` };
    }
    try {
      const result = await callProcessor(this.fetchImpl, `${this.baseUrl}/healz`, {
        method: "GET",
      });
      if (!result.ok) {
        return {
          ok: false,
          message: `Serverul Netopia a răspuns cu eroare (cod HTTP ${result.status}).`,
        };
      }
      return {
        ok: true,
        message:
          "Serverul Netopia răspunde, iar datele sunt completate și valide ca format. Cheia API nu se poate verifica fără o plată de test (neconfirmat).",
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof IntegrationError ? error.message : "Conexiunea la Netopia a eșuat.",
      };
    }
  }
}
