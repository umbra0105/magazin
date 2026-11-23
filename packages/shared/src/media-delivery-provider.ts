import type { ConnectionTestResult } from "./payment-provider";

/**
 * Contractul furnizorilor de livrare a conținutului digital (Faza 14b): interfața `MediaDeliveryProvider`, cu trei drivere în
 * `@ecom/integrations`: `local` (dezvoltare; stocarea platformei, cu linkuri semnate), `bunny` (video; embed semnat) și `s3`
 * (fișiere; linkuri presemnate). Tipurile sunt doar de date simple, ca adaptoarele să nu depindă de logica de business.
 *
 * ⚠️ Cheia de stocare (`storageKey`) și credențialele NU ies din server: un adaptor nu le pune în mesaje de eroare, iar singurul
 * lucru pe care îl vede clientul e `AccessGrant` (un URL cu expirare scurtă). Nu există link permanent și nici link fără expirare.
 */

export const MEDIA_DELIVERY_DRIVER_CODES = ["local", "bunny", "s3"] as const;
export type MediaDeliveryDriverCode = (typeof MEDIA_DELIVERY_DRIVER_CODES)[number];

export type DeliveryAssetType = "video" | "file";

/** Un conținut stocat: cum îl regăsește furnizorul. */
export interface DeliveryAssetRef {
  type: DeliveryAssetType;
  storageKey: string;
  /** Numele sub care se descarcă un fișier (Content-Disposition). */
  originalName: string | null;
  mimeType: string | null;
}

export interface DeliveryStoreInput {
  type: DeliveryAssetType;
  /** Octeții fișierului (mărimea e deja limitată de ruta de încărcare). */
  body: Buffer;
  fileName: string;
  mimeType: string;
}

export interface DeliveryStored {
  storageKey: string;
  /** `processing` = transcodarea încă rulează (Bunny); `ready` = poate fi livrat. */
  status: "ready" | "processing";
  fileSize: number;
  durationSeconds: number | null;
}

export type DeliveryMode = "download" | "play";

export interface DeliveryAccessRequest {
  asset: DeliveryAssetRef;
  mode: DeliveryMode;
  /** Valabilitatea linkului, secunde (obligatorie, scurtă). */
  expiresInSeconds: number;
  /** Emailul cumpărătorului: filigran peste video, doar unde furnizorul îl poate pune (Bunny). `null` = fără (preview public). */
  viewerEmail: string | null;
  now: Date;
}

/** Ce primește clientul: un URL cu expirare. `embed` = se pune într-un `<iframe>`; `url` = se descarcă sau se pune într-un `<video>`. */
export interface AccessGrant {
  kind: "url" | "embed";
  url: string;
  expiresAt: Date;
  /** Filigranul cu emailul cumpărătorului e cerut furnizorului pentru acest link. */
  watermarked: boolean;
}

export interface MediaDeliveryProvider {
  readonly code: MediaDeliveryDriverCode;
  readonly label: string;
  /** Stochează un conținut nou și întoarce cheia lui. */
  store(input: DeliveryStoreInput): Promise<DeliveryStored>;
  /** Starea unui conținut aflat în procesare (Bunny); celelalte drivere sunt mereu `ready`. */
  status(storageKey: string): Promise<"ready" | "processing" | "failed">;
  /** Link cu expirare scurtă. Aruncă `IntegrationError` cu cod `MEDIA_DELIVERY_*`. */
  createAccess(request: DeliveryAccessRequest): Promise<AccessGrant>;
  /** Idempotent: ștergerea unui conținut inexistent nu e eroare. */
  remove(storageKey: string): Promise<void>;
  testConnection(): Promise<ConnectionTestResult>;
}

export type MediaDeliveryErrorCode =
  | "MEDIA_DELIVERY_NOT_CONFIGURED"
  | "MEDIA_DELIVERY_UNREACHABLE"
  | "MEDIA_DELIVERY_REJECTED"
  | "MEDIA_DELIVERY_BAD_RESPONSE"
  | "MEDIA_DELIVERY_INVALID_EXPIRY";

/** Cât poate dura cel mult un link de acces (secunde): peste atât nu mai e «expirare scurtă». */
export const MEDIA_DELIVERY_MAX_LINK_SECONDS = 3600;
export const MEDIA_DELIVERY_MIN_LINK_SECONDS = 15;
export const MEDIA_DELIVERY_CALL_TIMEOUT_MS = 15_000;
