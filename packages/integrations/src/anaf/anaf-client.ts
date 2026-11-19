/**
 * Clientul pentru API-ul public ANAF «Platitor TVA» (fără cheie): găsește denumirea și adresa unei firme după CUI. Se folosește
 * doar ca AJUTOR la checkout (completare automată și starea «verificat»); o eroare ANAF NU blochează comanda, ci lasă CUI-ul
 * «neverificat». Adresa e fixă (nu vine din date), cererea are timp limită, iar răspunsul se validează manual (pachetul nu are Zod) și se tratează
 * defensiv (documentația v9 pomenește un plic `{cod: 200}` pe care răspunsul real nu îl trimite întotdeauna).
 * Limita ANAF: o cerere pe secundă; limitarea e a apelantului.
 */

export const ANAF_ENDPOINT = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";

export type AnafLookup =
  | { status: "found"; name: string; address: string; tradeRegisterNo: string | null }
  | { status: "not_found" }
  | { status: "unavailable"; reason: "timeout" | "http" | "network" | "invalid_response" };

export interface AnafClientOptions {
  /** `fetch`-ul de folosit (implicit cel global); testele îl înlocuiesc. */
  fetch?: typeof fetch;
  timeoutMs: number;
}

interface GeneralData {
  cui: string;
  name: string;
  address: string;
  tradeRegisterNo: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

/** Citește defensiv răspunsul ANAF: întoarce `null` dacă forma nu e cea așteptată (nu aruncă). */
function parseResponse(body: unknown): { found: GeneralData[]; notFound: string[] } | null {
  if (!isRecord(body)) return null;
  const found: GeneralData[] = [];
  for (const entry of Array.isArray(body["found"]) ? (body["found"] as unknown[]) : []) {
    const general = isRecord(entry) ? entry["date_generale"] : undefined;
    if (!isRecord(general)) return null;
    const name = textOf(general["denumire"]).trim();
    const cui = textOf(general["cui"]).trim();
    if (name === "" || cui === "") return null;
    found.push({
      cui,
      name,
      address: textOf(general["adresa"]).trim(),
      tradeRegisterNo: textOf(general["nrRegCom"]).trim(),
    });
  }
  const notFound = (Array.isArray(body["notFound"]) ? (body["notFound"] as unknown[]) : []).map(
    textOf,
  );
  if (found.length === 0 && notFound.length === 0) return null;
  return { found, notFound };
}

export class AnafClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnafClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  /** `cui` = doar cifrele; `today` = data locală `AAAA-LL-ZZ` (cerută de API). Nu aruncă niciodată. */
  async lookup(cui: string, today: string): Promise<AnafLookup> {
    if (!/^\d{2,10}$/.test(cui)) return { status: "unavailable", reason: "invalid_response" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(ANAF_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify([{ cui: Number(cui), data: today }]),
        signal: controller.signal,
      });
      if (!response.ok) return { status: "unavailable", reason: "http" };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: "unavailable", reason: "invalid_response" };
      }
      const parsed = parseResponse(body);
      if (!parsed) return { status: "unavailable", reason: "invalid_response" };
      const match = parsed.found.find((entry) => entry.cui === cui);
      if (match) {
        return {
          status: "found",
          name: match.name,
          address: match.address,
          tradeRegisterNo: match.tradeRegisterNo === "" ? null : match.tradeRegisterNo,
        };
      }
      if (parsed.notFound.includes(cui)) return { status: "not_found" };
      return { status: "unavailable", reason: "invalid_response" };
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return { status: "unavailable", reason: "timeout" };
      }
      return { status: "unavailable", reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}
