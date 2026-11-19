import { IntegrationError, PAYMENT_CALL_TIMEOUT_MS } from "@ecom/shared";

/**
 * Singurul loc din adaptoarele de plată care face un apel HTTP către un procesator: cu timp limită explicit (cel mult 10 s) și
 * erori fără secrete (mesajul nu conține adresa cu parametri, antetele sau corpul trimis). Corpul răspunsului e limitat ca
 * mărime. Testele dau un `fetch` fals.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpResult {
  status: number;
  ok: boolean;
  text: string;
}

const MAX_RESPONSE_CHARS = 200_000;

export async function callProcessor(
  fetchImpl: FetchLike | undefined,
  url: string,
  init: RequestInit,
  timeoutMs: number = PAYMENT_CALL_TIMEOUT_MS,
): Promise<HttpResult> {
  const timeout = Math.min(Math.max(timeoutMs, 1), PAYMENT_CALL_TIMEOUT_MS);
  const doFetch: FetchLike = fetchImpl ?? ((u, i) => fetch(u, i));
  let response: Response;
  try {
    response = await doFetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new IntegrationError(
      timedOut ? "PAYMENT_PROVIDER_TIMEOUT" : "PAYMENT_PROVIDER_UNREACHABLE",
      timedOut
        ? "Procesatorul de plăți nu a răspuns la timp"
        : "Procesatorul de plăți nu poate fi contactat",
    );
  }
  const text = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_CHARS);
  return { status: response.status, ok: response.ok, text };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text scurt, fără secrete și fără rânduri noi, pentru mesaje către administrator. */
export function safeSnippet(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  return text
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);
}
