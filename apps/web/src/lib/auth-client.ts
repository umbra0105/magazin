import type { Messages } from "@/messages";

/**
 * Apeluri către API-ul de autentificare din browser. Datele merg în corpul unui POST JSON, niciodată
 * în URL (emailul și parola nu ajung în istoric, loguri de proxy sau Referer).
 */

export type AuthResult =
  { ok: true } | { ok: false; status: number; code: string; retryAfterSeconds: number | null };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function authPost(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR", retryAfterSeconds: null };
  }
  if (response.ok) return { ok: true };

  let code = "";
  try {
    const json = (await response.json()) as { code?: unknown };
    if (typeof json.code === "string") code = json.code;
  } catch {
    // corp non-JSON: rămâne doar statusul
  }
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  return {
    ok: false,
    status: response.status,
    code,
    retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  };
}

export type AuthContext = "login" | "register" | "forgot" | "reset" | "verify";

/**
 * Textul de afișat pentru o eroare a API-ului. Nu adaugă informații peste ce spune API-ul:
 * credențiale greșite = același mesaj indiferent de motiv (email inexistent, parolă greșită, cont
 * blocat); 429 = câte minute de așteptat din `Retry-After`.
 */
export function authErrorMessage(
  result: Extract<AuthResult, { ok: false }>,
  context: AuthContext,
  m: Messages["auth"],
): string {
  if (result.status === 429 || result.code === "AUTH_RATE_LIMITED") {
    return m.common.rateLimited(result.retryAfterSeconds);
  }
  if (result.code === "NETWORK_ERROR") return m.common.networkError;
  switch (result.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return m.login.invalidCredentials;
    case "EMAIL_NOT_VERIFIED":
      return m.login.emailNotVerified;
    case "INVALID_TOKEN":
      return context === "reset" ? m.reset.invalidToken : m.verify.error;
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return m.register.emailTaken;
    default:
      return m.common.genericError;
  }
}
