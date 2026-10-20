import type { APIResponse } from "@playwright/test";

/**
 * Diagnostic pentru răspunsurile API din testele E2E: când un răspuns nu e reușit, eroarea spune CE s-a cerut,
 * statusul și corpul răspunsului (scurtat, fără parole, token-uri, secrete sau cookie-uri), nu doar «expected
 * true, received false». Așa un eșec intermitent din CI (ex. 429 de la limitatorul de înregistrări) se citește
 * direct din raport.
 */

const SECRET_KEY = /pass|token|secret|cookie|authorization|apikey|key/i;
const MAX_BODY = 400;

/** Corpul răspunsului ca text scurt, cu valorile câmpurilor sensibile înlocuite. */
export function redactBody(raw: string): string {
  let text: string;
  try {
    const parsed: unknown = JSON.parse(raw);
    text = JSON.stringify(parsed, (key, value: unknown) =>
      key !== "" && SECRET_KEY.test(key) ? "[ascuns]" : value,
    );
  } catch {
    text = raw
      .replace(
        /(pass(?:word)?|token|secret|cookie|authorization)(["'\s:=]+)[^\s"',;&}]+/gi,
        "$1$2[ascuns]",
      )
      .replace(/\s+/g, " ");
  }
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text;
}

/** Descrierea unui răspuns eșuat: status + corp redactat. */
export async function describeFailure(response: APIResponse, what: string): Promise<string> {
  let body: string;
  try {
    body = redactBody(await response.text());
  } catch {
    body = "(corpul nu a putut fi citit)";
  }
  return `${what}: răspuns HTTP ${response.status()} ${response.statusText()}; corp: ${body || "(gol)"}`;
}

/** Aruncă o eroare cu status și corp dacă răspunsul nu e reușit. */
export async function expectResponseOk(response: APIResponse, what: string): Promise<void> {
  if (response.ok()) return;
  throw new Error(await describeFailure(response, what));
}
