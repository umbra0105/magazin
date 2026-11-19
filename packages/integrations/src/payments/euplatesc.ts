import { randomBytes } from "node:crypto";
import {
  IntegrationError,
  WebhookRejectedError,
  decimalStringToMinor,
  minorToDecimalString,
  type CaptureOutcome,
  type ConnectionTestResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type PaymentMode,
  type PaymentProvider,
  type ProviderStatus,
  type RefundOutcome,
  type RefundRequest,
  type VerifiedWebhook,
  type WebhookRequest,
} from "@ecom/shared";
import {
  EUPLATESC_OPTIONAL_RESPONSE_FIELDS,
  euplatescTimestamp,
  isHexKey,
  sameSignature,
  signFields,
  type SignedField,
} from "./euplatesc-signature";
import { callProcessor, isRecord, parseJson, safeSnippet, type FetchLike } from "./http";

/**
 * Adaptorul EuPlătesc, reimplementat cu `node:crypto` și `fetch` după specificația bibliotecii MIT `euplatesc` (nu e
 * dependență a proiectului). ⚠️ NECONFIRMAT, DE VERIFICAT CU SANDBOX REAL: nume de câmpuri, ordinea din hash, formatul
 * răspunsurilor și modul test. Modul «test» folosește MID-ul și cheia magazinului (în starea «test» la EuPlătesc), fără sumă
 * forțată și fără contul comun de test al bibliotecii.
 */

export const EUPLATESC_GATEWAY_URL = "https://secure.euplatesc.ro/tdsprocess/tranzactd.php";
export const EUPLATESC_API_URL = "https://manager.euplatesc.ro/v3/index.php?action=ws";

export interface EuplatescCredentials {
  merchantId: string;
  secretKey: string;
  /** Doar pentru rambursare: utilizatorul API (cheie și parolă API). */
  userKey?: string;
  userApi?: string;
}

export interface EuplatescOptions {
  credentials: EuplatescCredentials;
  mode: Exclude<PaymentMode, "demo">;
  fetch?: FetchLike;
  now?: () => Date;
  /** 16 octeți aleatorii; testele îl înlocuiesc. */
  nonce?: () => string;
}

/**
 * Câmpurile de bază ale notificării: numele din hash și numele alternative sub care le-ar putea trimite procesatorul
 * (⚠️ neconfirmat: documentația bibliotecii le arată în camelCase, protocolul clasic în snake_case). Dacă un câmp vine sub
 * două nume cu valori diferite, notificarea e respinsă.
 */
const BASE_FIELDS: ReadonlyArray<readonly [string, ...string[]]> = [
  ["amount"],
  ["curr", "currency"],
  ["invoice_id", "invoiceId"],
  ["ep_id", "epId"],
  ["merch_id", "merchantId"],
  ["action"],
  ["message"],
  ["approval"],
  ["timestamp"],
  ["nonce"],
];

type Picked = { found: false } | { found: true; value: string } | { conflict: true };

function pick(params: URLSearchParams, names: readonly string[]): Picked {
  const values = names.filter((n) => params.has(n)).map((n) => params.get(n) ?? "");
  if (values.length === 0) return { found: false };
  if (values.some((v) => v !== values[0])) return { conflict: true };
  return { found: true, value: values[0] ?? "" };
}

export class EuplatescProvider implements PaymentProvider {
  readonly code = "euplatesc" as const;
  readonly mode: PaymentMode;
  private readonly creds: EuplatescCredentials;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(options: EuplatescOptions) {
    this.creds = options.credentials;
    this.mode = options.mode;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
  }

  private assertConfigured(): void {
    if (!this.creds.merchantId.trim() || !isHexKey(this.creds.secretKey)) {
      throw new IntegrationError(
        "PAYMENT_PROVIDER_NOT_CONFIGURED",
        "EuPlătesc nu este configurat: ID-ul de comerciant sau cheia secretă lipsesc ori nu sunt valide",
      );
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.assertConfigured();
    const hashed: SignedField[] = [
      ["amount", minorToDecimalString(input.amountMinor)],
      ["curr", input.currency],
      ["invoice_id", input.paymentRef],
      ["order_desc", input.description],
      ["merch_id", this.creds.merchantId],
      ["timestamp", euplatescTimestamp(this.now())],
      ["nonce", this.nonce()],
    ];
    const params = new URLSearchParams();
    for (const [name, value] of hashed) params.set(name, value ?? "");
    params.set("fp_hash", signFields(hashed, this.creds.secretKey));
    const c = input.customer;
    const extras: Array<[string, string]> = [
      ["fname", c.firstName],
      ["lname", c.lastName],
      ["add", c.street],
      ["city", c.city],
      ["state", c.county],
      ["zip", c.postalCode],
      ["country", "Romania"],
      ["phone", c.phone],
      ["email", c.email],
      ["ExtraData[silenturl]", input.notifyUrl],
      ["ExtraData[successurl]", input.returnUrl],
      ["ExtraData[failedurl]", input.returnUrl],
      ["ExtraData[ep_method]", "getclean"],
      ["lang", "ro"],
    ];
    for (const [name, value] of extras) if (value) params.set(name, value);
    return {
      providerRef: null,
      redirect: { url: `${EUPLATESC_GATEWAY_URL}?${params.toString()}`, method: "GET" },
    };
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    if (!this.creds.merchantId.trim() || !isHexKey(this.creds.secretKey)) {
      throw new WebhookRejectedError("not_configured");
    }
    const params = new URLSearchParams(request.rawBody.toString("utf8"));
    const hashField = pick(params, ["fp_hash", "fpHash"]);
    if ("conflict" in hashField) throw new WebhookRejectedError("body_invalid");
    if (!hashField.found || hashField.value === "")
      throw new WebhookRejectedError("signature_missing");
    const given = hashField.value;
    const fields: SignedField[] = [];
    const values = new Map<string, string>();
    for (const [hashName, ...aliases] of BASE_FIELDS) {
      const picked = pick(params, [hashName, ...aliases]);
      if ("conflict" in picked || !picked.found) throw new WebhookRejectedError("body_invalid");
      fields.push([hashName, picked.value]);
      values.set(hashName, picked.value);
    }
    for (const [hashName, requestName] of EUPLATESC_OPTIONAL_RESPONSE_FIELDS) {
      // câmpurile suplimentare intră în hash exact cum au fost primite
      const picked = pick(params, [hashName, requestName]);
      if ("conflict" in picked) throw new WebhookRejectedError("body_invalid");
      if (picked.found) {
        fields.push([hashName, picked.value]);
        values.set(hashName, picked.value);
      }
    }
    let expected: string;
    try {
      expected = signFields(fields, this.creds.secretKey);
    } catch {
      throw new WebhookRejectedError("not_configured");
    }
    if (!sameSignature(given, expected)) throw new WebhookRejectedError("signature_invalid");

    // semnătura e validă: câmpurile pot fi crezute
    const value = (name: string) => values.get(name) ?? "";
    if (value("merch_id") !== this.creds.merchantId) throw new WebhookRejectedError("body_invalid");
    const amountMinor = decimalStringToMinor(value("amount"));
    const mcard = value("mcard");
    return {
      event: {
        eventId: `${value("ep_id")}:${given.toLowerCase()}`,
        paymentRef: value("invoice_id"),
        providerRef: value("ep_id") || null,
        outcome: value("action") === "0" ? "paid" : "failed",
        rawStatus: `action=${safeSnippet(value("action"), 20)}`,
        amountMinor,
        currency: value("curr") || null,
        cardLast4: /^\d{4}$/.test(mcard) ? mcard : null,
      },
      response: { status: 200, contentType: "text/plain; charset=utf-8", body: "OK" },
    };
  }

  async capture(): Promise<CaptureOutcome> {
    return {
      status: "unsupported",
      message: "EuPlătesc capturează automat plata; nu e nevoie de captură manuală.",
    };
  }

  /** Apel către API-ul de administrare (formular semnat). `useUserKey`: semnat cu cheia utilizatorului API, nu cu cea a MID-ului. */
  private async managerCall(
    payload: ReadonlyArray<readonly [string, string]>,
    useUserKey: boolean,
  ): Promise<{ status: number; ok: boolean; json: unknown }> {
    const fields: SignedField[] = [
      ...payload,
      ["timestamp", euplatescTimestamp(this.now())],
      ["nonce", this.nonce()],
    ];
    const hash = signFields(fields, useUserKey ? (this.creds.userApi ?? "") : this.creds.secretKey);
    const body = new URLSearchParams();
    for (const [name, value] of fields) body.set(name, value ?? "");
    body.set("fp_hash", hash);
    const result = await callProcessor(this.fetchImpl, EUPLATESC_API_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return { status: result.status, ok: result.ok, json: parseJson(result.text) };
  }

  async refund(request: RefundRequest): Promise<RefundOutcome> {
    const { userKey, userApi } = this.creds;
    if (!userKey || !userApi || !isHexKey(userApi) || !isHexKey(this.creds.secretKey)) {
      return {
        status: "manual_required",
        message:
          "Utilizatorul API EuPlătesc (cheia și parola API) nu e configurat: rambursează din contul EuPlătesc, apoi confirmă manual.",
      };
    }
    // motivul cere 5–55 de caractere la EuPlătesc
    const reason = (
      request.reason.trim().length >= 5 ? request.reason.trim() : "Rambursare comanda"
    ).slice(0, 55);
    try {
      const response = await this.managerCall(
        [
          ["method", "refund"],
          ["ukey", userKey],
          ["amount", minorToDecimalString(request.amountMinor)],
          ["reason", reason],
          ["epid", request.providerRef],
        ],
        true,
      );
      if (response.ok && isRecord(response.json) && response.json["success"] !== undefined) {
        return { status: "confirmed", providerRef: null };
      }
      if (response.ok && isRecord(response.json) && response.json["error"] !== undefined) {
        return {
          status: "failed",
          message: `EuPlătesc a refuzat rambursarea: ${safeSnippet(response.json["error"] ?? response.json["message"])}`,
        };
      }
      return {
        status: "manual_required",
        message:
          "Răspuns neașteptat de la EuPlătesc: verifică în contul EuPlătesc dacă rambursarea a fost făcută înainte de a o repeta.",
      };
    } catch (error) {
      // timp depășit / rețea: rambursarea poate fi făcută sau nu; nu se presupune nimic
      void error;
      return {
        status: "manual_required",
        message:
          "EuPlătesc nu a răspuns clar: verifică în contul EuPlătesc dacă rambursarea a fost făcută înainte de a o repeta.",
      };
    }
  }

  async getStatus(ref: {
    providerRef: string | null;
    paymentRef: string;
  }): Promise<ProviderStatus | null> {
    this.assertConfigured();
    const response = await this.managerCall(
      [
        ["method", "check_status"],
        ["mid", this.creds.merchantId],
        ref.providerRef ? ["epid", ref.providerRef] : ["invoice_id", ref.paymentRef],
      ],
      false,
    );
    if (!response.ok || !isRecord(response.json)) {
      throw new IntegrationError(
        "PAYMENT_PROVIDER_BAD_RESPONSE",
        "Răspuns neașteptat de la EuPlătesc",
      );
    }
    let entries: unknown = response.json["success"];
    if (typeof entries === "string") entries = parseJson(entries);
    if (!Array.isArray(entries)) return null;
    const match = entries.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && String(entry["invoice_id"] ?? "") === ref.paymentRef,
    );
    if (!match) return null;
    const action = String(match["action"] ?? "");
    const captured = typeof match["captured_amount"] === "string" ? match["captured_amount"] : null;
    return {
      outcome: action === "0" ? "paid" : "failed",
      providerRef: typeof match["ep_id"] === "string" ? match["ep_id"] : ref.providerRef,
      // suma apare doar în formatul nou al răspunsului; fără ea, suma nu se poate verifica (fail-closed la apelant)
      amountMinor: captured === null ? null : decimalStringToMinor(captured),
      currency: null,
      rawStatus: `action=${safeSnippet(action, 20)}`,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    if (!this.creds.merchantId.trim() || !isHexKey(this.creds.secretKey)) {
      return {
        ok: false,
        message:
          "ID-ul de comerciant sau cheia secretă lipsesc ori nu sunt valide (cheia e hexazecimală).",
      };
    }
    try {
      const response = await this.managerCall(
        [
          ["method", "check_mid"],
          ["mid", this.creds.merchantId],
        ],
        false,
      );
      if (!response.ok || !isRecord(response.json)) {
        return { ok: false, message: "EuPlătesc a răspuns neașteptat; verifică datele introduse." };
      }
      if (response.json["error"] !== undefined) {
        return {
          ok: false,
          message: `EuPlătesc a refuzat datele: ${safeSnippet(response.json["error"])}`,
        };
      }
      const status = safeSnippet(response.json["status"], 20);
      if (this.mode === "live" && status === "test") {
        return {
          ok: false,
          message: "Contul EuPlătesc e încă în starea «test»: nu poate fi folosit în modul LIVE.",
        };
      }
      return {
        ok: true,
        message: `Conexiune reușită. Starea contului la EuPlătesc: ${status || "necunoscută"}.`,
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof IntegrationError ? error.message : "Conexiunea la EuPlătesc a eșuat.",
      };
    }
  }
}
