import { IntegrationError, SHIPPING_CALL_TIMEOUT_MS } from "@ecom/shared";
import { isRecord, parseJson, safeSnippet, type FetchLike } from "../payments/http";

export { isRecord, parseJson, safeSnippet, type FetchLike };

/**
 * Singurul loc din adaptoarele de curierat care face un apel HTTP: cu timp limită explicit (cel mult 10 s), fără urmărirea
 * redirecturilor și cu erori FĂRĂ date personale sau secrete (mesajul nu conține adresa cu parametri, antetele sau corpul
 * trimis ori primit). Testele dau un `fetch` fals.
 */
const MAX_RESPONSE_CHARS = 2_000_000;

export interface CarrierCall {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
  /** Corpul brut (pentru etichete PDF), limitat ca mărime. */
  bytes: Uint8Array;
}

export async function callCarrier(
  fetchImpl: FetchLike | undefined,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<CarrierCall> {
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => fetch(u, i));
  const timeout = AbortSignal.timeout(SHIPPING_CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new IntegrationError(
      timedOut ? "SHIPPING_PROVIDER_TIMEOUT" : "SHIPPING_PROVIDER_UNREACHABLE",
      timedOut ? "Curierul nu a răspuns la timp" : "Curierul nu poate fi contactat",
    );
  }
  const bytes = new Uint8Array(
    await response.arrayBuffer().catch(() => new ArrayBuffer(0)),
  ).subarray(0, MAX_RESPONSE_CHARS);
  const text = new TextDecoder().decode(bytes);
  return { status: response.status, ok: response.ok, text, json: parseJson(text), bytes };
}

/** Mesajul de eroare al curierului, scurt și curățat (poate fi afișat adminului; nu se pune niciodată corpul întreg). */
export function carrierMessage(json: unknown): string {
  if (isRecord(json)) {
    for (const key of ["error", "message"]) {
      const value = json[key];
      if (typeof value === "string") return safeSnippet(value);
    }
  }
  return "";
}

/** Suma zecimală din JSON-ul curierului (ex. 123.45 lei) în bani, FĂRĂ aritmetică pe float: ia textul cu 2 zecimale. */
export function decimalToMinor(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const [whole = "0", fraction = "00"] = n.toFixed(2).split(".");
  return Number(whole) * 100 + Number(fraction);
}

/** Bani → număr cu 2 zecimale («12345» → 123.45), pentru API-urile care cer lei ca număr; construit din cifre, fără împărțire. */
export function minorToDecimal(minor: number): number {
  const digits = String(Math.max(0, Math.trunc(minor))).padStart(3, "0");
  return Number(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
}

/** Nume de județ sau localitate fără diacritice, litere mici, fără prefixe administrative: pentru potrivirea cu nomenclatorul curierului. */
export function normalizePlaceName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(municipiul|orasul|comuna|judetul|jud\.?|mun\.?|sat|satul)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function bytesFromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}
