import { IntegrationError, INVOICE_CALL_TIMEOUT_MS } from "@ecom/shared";
import { isRecord, parseJson, safeSnippet, type FetchLike } from "../payments/http";

export { isRecord, parseJson, safeSnippet, type FetchLike };

/**
 * Singurul loc din adaptoarele de facturare care face un apel HTTP: cu timp limită explicit, fără urmărirea redirecturilor și cu
 * erori FĂRĂ date personale sau secrete (mesajul nu conține adresa cu parametri, antetele, corpul trimis ori primit). Testele dau
 * un `fetch` fals.
 */
const MAX_RESPONSE_BYTES = 8_000_000;

/** Erorile de rețea la care cererea NU a ajuns la furnizor (sigur de reîncercat, fără risc de document dublu). */
const BEFORE_SEND_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export interface InvoiceCall {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
  bytes: Uint8Array;
  headers: Headers;
}

function networkCode(error: unknown): string | null {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : null;
  const code = isRecord(cause) ? cause["code"] : null;
  return typeof code === "string" ? code : null;
}

export async function callInvoiceProvider(
  fetchImpl: FetchLike | undefined,
  url: string,
  init: RequestInit,
): Promise<InvoiceCall> {
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => fetch(u, i));
  let response: Response;
  try {
    response = await doFetch(url, {
      ...init,
      signal: AbortSignal.timeout(INVOICE_CALL_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    const code = networkCode(error);
    if (!timedOut && code !== null && BEFORE_SEND_CODES.has(code)) {
      throw new IntegrationError(
        "INVOICE_PROVIDER_UNREACHABLE",
        "Furnizorul de facturare nu poate fi contactat",
      );
    }
    // timp depășit sau întrerupere în timpul apelului: cererea poate fi ajuns la furnizor (rezultat nesigur)
    throw new IntegrationError(
      "INVOICE_PROVIDER_TIMEOUT",
      "Furnizorul de facturare nu a răspuns la timp sau conexiunea s-a întrerupt",
    );
  }
  const bytes = new Uint8Array(
    await response.arrayBuffer().catch(() => new ArrayBuffer(0)),
  ).subarray(0, MAX_RESPONSE_BYTES);
  const text = new TextDecoder().decode(bytes);
  return {
    status: response.status,
    ok: response.ok,
    text,
    json: parseJson(text),
    bytes,
    headers: response.headers,
  };
}

/** Bani → număr cu 2 zecimale («12345» → 123.45), construit din cifre, fără împărțire. Acceptă negative. */
export function minorToDecimal(minor: number): number {
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(minor))).padStart(3, "0");
  return Number(`${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`);
}

/** Cantitate în zecimi de miime (multiplu de 100) → număr cu 2 zecimale, din cifre. Acceptă negative. */
export function ticksToDecimal(ticks: bigint): number {
  if (ticks % 100n !== 0n) {
    throw new IntegrationError(
      "INVOICE_REJECTED",
      "Cantitatea de pe factură are mai mult de 2 zecimale",
    );
  }
  const hundredths = ticks / 100n;
  const sign = hundredths < 0n ? "-" : "";
  const digits = String(hundredths < 0n ? -hundredths : hundredths).padStart(3, "0");
  return Number(`${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`);
}

/** Data calendaristică «AAAA-LL-ZZ» în fusul României (data fiscală a documentului). */
export function bucharestDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
