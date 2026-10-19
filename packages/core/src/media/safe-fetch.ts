import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { checkImageUrl, type ImageUrlRejection } from "./image-url";
import { isPublicAddress } from "./ip-guard";

/**
 * SINGURUL loc din codul de import și de media care face cereri de rețea (testul de arhitectură
 * `no-network-outside-safe-fetch` pică dacă `fetch`, `http(s).request`, `axios`, `undici` sau similar apare
 * în altă parte). Descarcă o imagine de la o adresă din fișierul de import, cu aceste controale, toate
 * obligatorii și fără comutator de producție:
 *
 *  1. adresa: https, port 443, fără utilizator/parolă/fragment/IP literal, lungime maximă, gazda în lista
 *     de domenii permise (potrivire exactă pe numele normalizat; lista goală = nimic permis);
 *  2. DNS rezolvat ÎNAINTE de conectare, O SINGURĂ DATĂ pe salt: TOATE adresele trebuie să fie publice
 *     (`ip-guard`); dacă una singură e privată, se respinge tot numele. Lista de domenii nu anulează asta;
 *  3. conexiunea e FIXATĂ la IP-ul validat (împotriva DNS rebinding: nu mai există o a doua rezolvare între
 *     verificare și conectare), cu certificatul TLS și SNI/Host verificate pe numele gazdei;
 *  4. redirecturi manuale, cel mult `maxRedirects` (plafon 3), numai în cadrul ACEleiași gazde, fiecare salt
 *     revalidat de la zero (adresă, listă, DNS, IP);
 *  5. limite: timeout de conectare și total, mărime maximă pe flux cu oprire imediată (Content-Length nu e
 *     de încredere), \`Accept-Encoding: identity\` (răspuns comprimat = refuz), fără cookie-uri sau
 *     autorizare, User-Agent fix;
 *  6. erori fără scurgeri: coduri stabile, niciodată IP-uri rezolvate, anteturi, corpuri sau trasee.
 *
 * Tipul și conținutul imaginii NU se decid aici: octeții merg în conducta bibliotecii media (tip din octeți,
 * SVG refuzat, reencodare, limită de pixeli). Rezolvatorul și conectorul sunt injectabile pentru teste;
 * implicitul este cel sigur, fără nicio variabilă de mediu care să-l schimbe.
 */

export type SafeFetchErrorCode =
  | ImageUrlRejection
  | "dns_failed"
  | "address_not_public"
  | "connect_failed"
  | "timeout"
  | "too_many_redirects"
  | "redirect_refused"
  | "bad_status"
  | "compressed"
  | "too_large"
  | "empty";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    /** Gazda (nu adresa completă), acolo unde ajută administratorul. */
    readonly host: string | null = null,
  ) {
    super(code);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchPolicy {
  allowedHosts: readonly string[];
  maxUrlLength: number;
  maxBytes: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxRedirects: number;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ConnectRequest {
  /** Numele gazdei: pentru SNI, antetul Host și verificarea certificatului. */
  host: string;
  /** IP-ul deja validat, la care se conectează. */
  address: ResolvedAddress;
  /** Calea și query-ul. */
  path: string;
  headers: Readonly<Record<string, string>>;
  connectTimeoutMs: number;
  signal: AbortSignal;
}

export interface ConnectResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Închide conexiunea (oprește citirea). */
  close(): void;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;
export type Connector = (request: ConnectRequest) => Promise<ConnectResponse>;

export interface SafeFetchDeps {
  resolve?: Resolver;
  connect?: Connector;
  now?: () => number;
}

/** Antetele trimise la fiecare cerere: fixe, fără cookie-uri, autorizare sau antete interne. */
export const SAFE_FETCH_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "EcomImageImport/1.0",
  Accept: "image/*",
  "Accept-Encoding": "identity",
  Connection: "close",
};

const MAX_ADDRESSES_TRIED = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Rezolvatorul implicit: DNS-ul sistemului, toate adresele (A și AAAA), în ordinea primită. */
export const defaultResolve: Resolver = async (host) => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.flatMap((row) =>
    row.family === 4 || row.family === 6 ? [{ address: row.address, family: row.family }] : [],
  );
};

/**
 * Conectorul implicit: `https.request` către IP-ul fixat (funcția `lookup` returnează mereu adresa dată),
 * deci nu există o a doua rezolvare; certificatul se verifică pe `host` (implicit, `rejectUnauthorized`),
 * iar SNI și antetul Host sunt tot `host`.
 */
export const defaultConnect: Connector = (request) =>
  new Promise<ConnectResponse>((resolve, reject) => {
    let connected = false;
    const req = httpsRequest({
      host: request.host,
      port: 443,
      method: "GET",
      path: request.path,
      headers: { ...request.headers },
      agent: false,
      servername: request.host,
      rejectUnauthorized: true,
      signal: request.signal,
      lookup: (_host, options, callback) => {
        const { address, family } = request.address;
        if ((options as { all?: boolean }).all) {
          (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
            { address, family },
          ]);
        } else {
          callback(null, address, family);
        }
      },
    });
    const connectTimer = setTimeout(() => {
      if (!connected) req.destroy(new Error("connect timeout"));
    }, request.connectTimeoutMs);
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });
    req.on("error", (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    req.on("response", (res) => {
      connected = true;
      clearTimeout(connectTimer);
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      resolve({
        status: res.statusCode ?? 0,
        headers,
        body: res as AsyncIterable<Uint8Array>,
        close: () => req.destroy(),
      });
    });
    req.end();
  });

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SafeFetchError("timeout")), Math.max(ms, 1));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Descarcă o imagine. Aruncă `SafeFetchError` cu cod stabil; octeții întorși NU sunt de încredere până nu trec
 * prin conducta media (tip din octeți, reencodare).
 */
export async function safeFetchImage(
  rawUrl: string,
  policy: SafeFetchPolicy,
  deps: SafeFetchDeps = {},
): Promise<{ bytes: Buffer; host: string }> {
  const resolveHost = deps.resolve ?? defaultResolve;
  const connect = deps.connect ?? defaultConnect;
  const now = deps.now ?? Date.now;
  const deadline = now() + policy.totalTimeoutMs;
  const remaining = (): number => deadline - now();
  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(), policy.totalTimeoutMs);

  try {
    let current = rawUrl;
    let firstHost: string | null = null;
    for (let hop = 0; ; hop++) {
      // 1. adresa (la fiecare salt, de la zero)
      const checked = checkImageUrl(current, policy);
      if (!checked.ok) throw new SafeFetchError(checked.reason, checked.host);
      if (firstHost !== null && checked.host !== firstHost) {
        throw new SafeFetchError("redirect_refused", checked.host);
      }
      firstHost ??= checked.host;

      // 2. DNS, o singură dată, și TOATE adresele publice
      let addresses: ResolvedAddress[];
      try {
        addresses = await withDeadline(
          resolveHost(checked.host),
          Math.min(policy.connectTimeoutMs, remaining()),
        );
      } catch (error) {
        if (error instanceof SafeFetchError) throw new SafeFetchError("timeout", checked.host);
        throw new SafeFetchError("dns_failed", checked.host);
      }
      if (addresses.length === 0) throw new SafeFetchError("dns_failed", checked.host);
      if (addresses.some((a) => !isPublicAddress(a.address))) {
        throw new SafeFetchError("address_not_public", checked.host);
      }

      // 3. conectare la IP-ul validat (cel mult câteva adrese, în ordine)
      let response: ConnectResponse | null = null;
      for (const address of addresses.slice(0, MAX_ADDRESSES_TRIED)) {
        if (remaining() <= 0 || controller.signal.aborted)
          throw new SafeFetchError("timeout", checked.host);
        try {
          response = await connect({
            host: checked.host,
            address,
            path: checked.path,
            headers: SAFE_FETCH_HEADERS,
            connectTimeoutMs: Math.min(policy.connectTimeoutMs, Math.max(remaining(), 1)),
            signal: controller.signal,
          });
          break;
        } catch {
          if (controller.signal.aborted) throw new SafeFetchError("timeout", checked.host);
        }
      }
      if (!response) throw new SafeFetchError("connect_failed", checked.host);

      // 4. redirect manual
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers["location"];
        response.close();
        if (hop >= policy.maxRedirects)
          throw new SafeFetchError("too_many_redirects", checked.host);
        if (!location) throw new SafeFetchError("redirect_refused", checked.host);
        try {
          current = new URL(location, `https://${checked.host}${checked.path}`).href;
        } catch {
          throw new SafeFetchError("redirect_refused", checked.host);
        }
        continue;
      }
      if (response.status !== 200) {
        response.close();
        throw new SafeFetchError("bad_status", checked.host);
      }
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (encoding && encoding !== "identity") {
        response.close();
        throw new SafeFetchError("compressed", checked.host);
      }

      // 5. corpul, cu plafon pe flux (Content-Length nu e de încredere; e doar o scurtătură)
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > policy.maxBytes) {
        response.close();
        throw new SafeFetchError("too_large", checked.host);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > policy.maxBytes) {
            response.close();
            throw new SafeFetchError("too_large", checked.host);
          }
          if (remaining() <= 0) {
            response.close();
            throw new SafeFetchError("timeout", checked.host);
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) {
        response.close();
        if (error instanceof SafeFetchError) throw error;
        throw new SafeFetchError(
          controller.signal.aborted ? "timeout" : "connect_failed",
          checked.host,
        );
      }
      if (size === 0) throw new SafeFetchError("empty", checked.host);
      return { bytes: Buffer.concat(chunks, size), host: checked.host };
    }
  } finally {
    clearTimeout(total);
    controller.abort();
  }
}

/** Mesaje generice în română, pentru raport și istoric (fără IP-uri, anteturi sau detalii interne). */
export const SAFE_FETCH_MESSAGES: Readonly<Record<SafeFetchErrorCode, string>> = {
  too_long: "adresă prea lungă",
  invalid: "adresă invalidă",
  scheme: "adresă respinsă (doar https)",
  credentials: "adresă respinsă (cu utilizator sau parolă)",
  port: "adresă respinsă (doar portul 443)",
  fragment: "adresă respinsă (cu fragment)",
  ip_literal: "adresă respinsă (IP în loc de domeniu)",
  no_hosts_configured: "nicio imagine nu se descarcă: lista de domenii permise e goală",
  host_not_allowed: "domeniu nepermis",
  dns_failed: "descărcare eșuată (domeniul nu răspunde)",
  address_not_public: "adresă respinsă (nu duce la un server public)",
  connect_failed: "descărcare eșuată",
  timeout: "timp depășit",
  too_many_redirects: "adresă respinsă (prea multe redirecturi)",
  redirect_refused: "adresă respinsă (redirect către altă gazdă)",
  bad_status: "descărcare eșuată (răspuns neașteptat)",
  compressed: "descărcare eșuată (răspuns comprimat)",
  too_large: "imagine prea mare",
  empty: "descărcare eșuată (răspuns gol)",
};
