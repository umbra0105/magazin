import type { PaymentProviderCode } from "@ecom/shared";

/**
 * Câmpurile de credențiale ale fiecărui furnizor de plată (Faza 10) și etichetele lor în română. Toate se păstrează criptat
 * (AES-256-GCM, `IntegrationService`, tipul «payment») și NU se afișează niciodată după salvare: ecranul arată doar «salvat».
 */
export interface ProviderField {
  key: string;
  label: string;
  required: boolean;
  /** Valoare pe mai multe rânduri (cheia publică PEM). */
  multiline?: boolean;
  hint?: string;
}

export interface ProviderInfo {
  code: PaymentProviderCode;
  label: string;
  fields: readonly ProviderField[];
  /** Furnizor real (are mod test/live și garda «verificat în sandbox»). */
  real: boolean;
}

export const PAYMENT_INTEGRATION_TYPE = "payment";

export const PROVIDERS: Readonly<Record<PaymentProviderCode, ProviderInfo>> = {
  netopia: {
    code: "netopia",
    label: "Netopia Payments",
    real: true,
    fields: [
      { key: "apiKey", label: "Cheie API", required: true },
      { key: "posSignature", label: "Semnătura POS", required: true },
      {
        key: "publicKey",
        label: "Cheie publică Netopia (verificarea notificărilor)",
        required: true,
        multiline: true,
        hint: "Se lipește cu tot cu liniile BEGIN/END sau doar conținutul.",
      },
    ],
  },
  euplatesc: {
    code: "euplatesc",
    label: "EuPlătesc",
    real: true,
    fields: [
      { key: "merchantId", label: "ID comerciant (MID)", required: true },
      { key: "secretKey", label: "Cheie secretă (KEY)", required: true },
      {
        key: "userKey",
        label: "Cheie utilizator API (opțional, pentru rambursări)",
        required: false,
      },
      {
        key: "userApi",
        label: "Parolă utilizator API (opțional, pentru rambursări)",
        required: false,
      },
    ],
  },
  demo: { code: "demo", label: "DEMO (doar dezvoltare)", real: false, fields: [] },
};

export function isProviderCode(value: string): value is PaymentProviderCode {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** Câmpurile obligatorii care lipsesc dintr-un set de credențiale. */
export function missingRequiredFields(
  code: PaymentProviderCode,
  credentials: Readonly<Record<string, string>> | null,
): string[] {
  return PROVIDERS[code].fields
    .filter((field) => field.required && !(credentials?.[field.key] ?? "").trim())
    .map((field) => field.label);
}
