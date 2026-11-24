import { randomUUID } from "node:crypto";
import {
  IntegrationError,
  MEDIA_DELIVERY_MAX_LINK_SECONDS,
  MEDIA_DELIVERY_MIN_LINK_SECONDS,
  type AccessGrant,
  type ConnectionTestResult,
  type DeliveryAccessRequest,
  type DeliveryStored,
  type DeliveryStoreInput,
  type MediaDeliveryProvider,
} from "@ecom/shared";
import type { StorageDriver } from "../storage/types";

/**
 * Driverele `local` și `s3` ale livrării de conținut digital: același cod peste un `StorageDriver`.
 *
 * - `local` = stocarea platformei (discul local sau MinIO din dezvoltare), pentru dezvoltare;
 * - `s3` = un bucket S3-compatibil propriu al magazinului (credențiale din admin), pentru fișiere (PDF, arhive).
 *
 * Conținutul stă în spațiul `private/digital/…`: nu are adresă publică, doar linkuri semnate cu expirare scurtă, create la cerere,
 * după ce serverul a verificat dreptul de acces. Fără filigran (nu poate fi pus peste un fișier servit direct).
 */
export const DIGITAL_KEY_PREFIX = "private/digital/";

const EXTENSION = /\.([A-Za-z0-9]{1,8})$/;

function keyFor(fileName: string, id: string): string {
  const extension = EXTENSION.exec(fileName.trim())?.[1]?.toLowerCase();
  return `${DIGITAL_KEY_PREFIX}${id}${extension ? `.${extension}` : ""}`;
}

export function assertLinkSeconds(seconds: number): void {
  if (
    !Number.isInteger(seconds) ||
    seconds < MEDIA_DELIVERY_MIN_LINK_SECONDS ||
    seconds > MEDIA_DELIVERY_MAX_LINK_SECONDS
  ) {
    throw new IntegrationError(
      "MEDIA_DELIVERY_INVALID_EXPIRY",
      `Linkul de acces trebuie să expire în ${MEDIA_DELIVERY_MIN_LINK_SECONDS}–${MEDIA_DELIVERY_MAX_LINK_SECONDS} de secunde`,
    );
  }
}

export interface StorageDeliveryOptions {
  code: "local" | "s3";
  label: string;
  storage: StorageDriver;
  /** Doar teste: id-ul din cheia de stocare. */
  newId?: () => string;
}

export class StorageDeliveryProvider implements MediaDeliveryProvider {
  readonly code: "local" | "s3";
  readonly label: string;

  constructor(private readonly options: StorageDeliveryOptions) {
    this.code = options.code;
    this.label = options.label;
  }

  async store(input: DeliveryStoreInput): Promise<DeliveryStored> {
    const key = keyFor(input.fileName, (this.options.newId ?? randomUUID)());
    await this.options.storage.put(key, input.body, {
      contentType: input.mimeType,
      cacheControl: "private, no-store",
    });
    return { storageKey: key, status: "ready", fileSize: input.body.length, durationSeconds: null };
  }

  async status(storageKey: string): Promise<"ready" | "processing" | "failed"> {
    const found = await this.options.storage.stat(storageKey);
    return found ? "ready" : "failed";
  }

  async createAccess(request: DeliveryAccessRequest): Promise<AccessGrant> {
    assertLinkSeconds(request.expiresInSeconds);
    const { asset } = request;
    const downloadFilename =
      request.mode === "download" && asset.originalName ? asset.originalName : undefined;
    const url = await this.options.storage.signedUrl(asset.storageKey, {
      expiresInSeconds: request.expiresInSeconds,
      ...(downloadFilename ? { downloadFilename } : {}),
    });
    return {
      kind: "url",
      url,
      expiresAt: new Date(request.now.getTime() + request.expiresInSeconds * 1000),
      watermarked: false,
    };
  }

  async remove(storageKey: string): Promise<void> {
    await this.options.storage.delete(storageKey);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const key = `${DIGITAL_KEY_PREFIX}test-${randomUUID()}.txt`;
    try {
      await this.options.storage.put(key, Buffer.from("test"), { contentType: "text/plain" });
      const found = await this.options.storage.stat(key);
      await this.options.storage.delete(key);
      return found
        ? { ok: true, message: "Stocarea răspunde: scriere, citire și ștergere reușite." }
        : { ok: false, message: "Stocarea a acceptat fișierul, dar nu îl regăsește." };
    } catch {
      return { ok: false, message: "Stocarea nu răspunde sau credențialele sunt greșite." };
    }
  }
}
