import { createHash } from "node:crypto";
import {
  IntegrationError,
  MEDIA_DELIVERY_CALL_TIMEOUT_MS,
  type AccessGrant,
  type ConnectionTestResult,
  type DeliveryAccessRequest,
  type DeliveryStored,
  type DeliveryStoreInput,
  type MediaDeliveryProvider,
} from "@ecom/shared";
import { isRecord, parseJson, type FetchLike } from "../payments/http";
import { assertLinkSeconds } from "./storage-delivery";

/**
 * Driverul `bunny` (Bunny Stream, doar video): încărcare prin API, transcodare făcută de Bunny, redare prin iframe-ul de embed cu
 * TOKEN semnat (`sha256(cheie_token + id_video + expirare)`) și expirare scurtă.
 *
 * ⚠️ ÎNCĂ NETESTAT CU UN CONT REAL: construit după documentația publică Bunny Stream și verificat DOAR pe răspunsuri simulate.
 * Presupuneri de verificat într-un cont real: căile și numele câmpurilor API-ului (`/library/{id}/videos`), codurile de stare ale
 * transcodării (4 = terminat; 5 și 6 = eșec), formula tokenului de embed și parametrul prin care emailul cumpărătorului ajunge ca
 * filigran (`watermark`; Bunny poate să nu accepte text dinamic). Până la confirmarea lui Owner, driverul nu poate fi activat.
 *
 * Cheile (`apiKey`, `tokenAuthKey`) vin criptate din baza de date, doar pe server; nu apar în mesaje de eroare, în loguri sau în
 * adresa returnată (tokenul e un hash, nu cheia).
 */
export interface BunnyCredentials {
  apiKey: string;
  libraryId: string;
  tokenAuthKey: string;
}

export interface BunnyOptions {
  credentials: BunnyCredentials;
  fetch?: FetchLike;
  apiBase?: string;
  embedBase?: string;
}

const API_BASE = "https://video.bunnycdn.com";
const EMBED_BASE = "https://iframe.mediadelivery.net/embed";
const MAX_RESPONSE_CHARS = 200_000;

/** Starea transcodării la Bunny: 0–3 în lucru, 4 terminat, 5 eroare, 6 încărcare eșuată. */
const FINISHED = 4;
const FAILED = new Set([5, 6]);

export class BunnyDeliveryProvider implements MediaDeliveryProvider {
  readonly code = "bunny" as const;
  readonly label = "Bunny Stream (video)";
  private readonly apiBase: string;
  private readonly embedBase: string;

  constructor(private readonly options: BunnyOptions) {
    this.apiBase = (options.apiBase ?? API_BASE).replace(/\/+$/, "");
    this.embedBase = (options.embedBase ?? EMBED_BASE).replace(/\/+$/, "");
  }

  private get library(): string {
    const id = this.options.credentials.libraryId.trim();
    if (!/^\d{1,12}$/.test(id) || !this.options.credentials.apiKey.trim()) {
      throw new IntegrationError(
        "MEDIA_DELIVERY_NOT_CONFIGURED",
        "Bunny Stream nu e configurat complet (cheie API și id de bibliotecă)",
      );
    }
    return id;
  }

  private async call(
    method: string,
    path: string,
    body?: { json?: unknown; bytes?: Buffer },
  ): Promise<{ status: number; ok: boolean; json: unknown }> {
    const doFetch: FetchLike = this.options.fetch ?? ((url, init) => fetch(url, init));
    const headers: Record<string, string> = {
      AccessKey: this.options.credentials.apiKey,
      Accept: "application/json",
    };
    let payload: string | Uint8Array | undefined;
    if (body?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.bytes) {
      headers["Content-Type"] = "application/octet-stream";
      payload = new Uint8Array(body.bytes);
    }
    let response: Response;
    try {
      response = await doFetch(`${this.apiBase}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(MEDIA_DELIVERY_CALL_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new IntegrationError(
        "MEDIA_DELIVERY_UNREACHABLE",
        "Bunny Stream nu poate fi contactat sau nu a răspuns la timp",
      );
    }
    const text = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_CHARS);
    if (response.status === 401 || response.status === 403) {
      throw new IntegrationError(
        "MEDIA_DELIVERY_REJECTED",
        "Bunny Stream a refuzat cheia API: verifică cheia și id-ul bibliotecii",
      );
    }
    return { status: response.status, ok: response.ok, json: parseJson(text) };
  }

  async store(input: DeliveryStoreInput): Promise<DeliveryStored> {
    if (input.type !== "video") {
      throw new IntegrationError(
        "MEDIA_DELIVERY_REJECTED",
        "Bunny Stream găzduiește doar videoclipuri; fișierele merg pe stocarea de fișiere",
      );
    }
    const library = this.library;
    const created = await this.call("POST", `/library/${library}/videos`, {
      json: { title: input.fileName.slice(0, 200) },
    });
    const guid = isRecord(created.json) ? created.json["guid"] : undefined;
    if (!created.ok || typeof guid !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(guid)) {
      throw new IntegrationError(
        "MEDIA_DELIVERY_BAD_RESPONSE",
        "Bunny Stream nu a creat videoclipul (răspuns neașteptat)",
      );
    }
    const uploaded = await this.call("PUT", `/library/${library}/videos/${guid}`, {
      bytes: input.body,
    });
    if (!uploaded.ok) {
      throw new IntegrationError(
        "MEDIA_DELIVERY_BAD_RESPONSE",
        "Bunny Stream a refuzat încărcarea videoclipului",
      );
    }
    // transcodarea o face Bunny: videoclipul e «în procesare» până răspunde starea lui
    return {
      storageKey: guid,
      status: "processing",
      fileSize: input.body.length,
      durationSeconds: null,
    };
  }

  async status(storageKey: string): Promise<"ready" | "processing" | "failed"> {
    const result = await this.call(
      "GET",
      `/library/${this.library}/videos/${encodeURIComponent(storageKey)}`,
    );
    if (result.status === 404) return "failed";
    const status = isRecord(result.json) ? result.json["status"] : undefined;
    if (!result.ok || typeof status !== "number") {
      throw new IntegrationError(
        "MEDIA_DELIVERY_BAD_RESPONSE",
        "Bunny Stream a răspuns cu o stare neinterpretabilă",
      );
    }
    if (status === FINISHED) return "ready";
    return FAILED.has(status) ? "failed" : "processing";
  }

  async createAccess(request: DeliveryAccessRequest): Promise<AccessGrant> {
    assertLinkSeconds(request.expiresInSeconds);
    if (request.asset.type !== "video") {
      throw new IntegrationError(
        "MEDIA_DELIVERY_REJECTED",
        "Bunny Stream livrează doar videoclipuri",
      );
    }
    const library = this.library;
    const key = this.options.credentials.tokenAuthKey;
    if (!key.trim()) {
      throw new IntegrationError(
        "MEDIA_DELIVERY_NOT_CONFIGURED",
        "Bunny Stream nu are cheia de autentificare a tokenului",
      );
    }
    const guid = request.asset.storageKey;
    const expires = Math.floor(request.now.getTime() / 1000) + request.expiresInSeconds;
    const token = createHash("sha256").update(`${key}${guid}${expires}`).digest("hex");
    const params = new URLSearchParams({ token, expires: String(expires) });
    const email = request.viewerEmail?.trim() ?? "";
    if (email) params.set("watermark", email);
    return {
      kind: "embed",
      url: `${this.embedBase}/${library}/${encodeURIComponent(guid)}?${params.toString()}`,
      expiresAt: new Date(expires * 1000),
      watermarked: email !== "",
    };
  }

  async remove(storageKey: string): Promise<void> {
    const result = await this.call(
      "DELETE",
      `/library/${this.library}/videos/${encodeURIComponent(storageKey)}`,
    );
    if (!result.ok && result.status !== 404) {
      throw new IntegrationError("MEDIA_DELIVERY_BAD_RESPONSE", "Bunny Stream a refuzat ștergerea");
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const result = await this.call(
        "GET",
        `/library/${this.library}/videos?page=1&itemsPerPage=1`,
      );
      return result.ok
        ? { ok: true, message: "Conexiunea la Bunny Stream funcționează." }
        : { ok: false, message: "Bunny Stream a răspuns cu o eroare." };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof IntegrationError ? error.message : "Conexiunea la Bunny Stream a eșuat.",
      };
    }
  }
}
