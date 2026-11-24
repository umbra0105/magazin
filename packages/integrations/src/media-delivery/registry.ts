import type { MediaDeliveryDriverCode, MediaDeliveryProvider } from "@ecom/shared";
import { IntegrationError } from "@ecom/shared";
import type { FetchLike } from "../payments/http";
import { S3StorageDriver } from "../storage/s3-driver";
import type { StorageDriver } from "../storage/types";
import { BunnyDeliveryProvider } from "./bunny";
import { StorageDeliveryProvider } from "./storage-delivery";

/**
 * Singura fabrică de drivere de livrare a conținutului digital: din cod, credențialele decriptate (doar pe server) și stocarea
 * platformei (pentru `local`). `local` nu cere cont; `bunny` și `s3` cer credențiale din admin și rămân «încă netestate cu un
 * cont real» până la confirmarea lui Owner (garda stă în `@ecom/core`, nu aici).
 */
export interface BuildMediaDeliveryInput {
  code: MediaDeliveryDriverCode;
  /** Stocarea platformei (`STORAGE_DRIVER`): folosită de driverul `local`. */
  platformStorage: StorageDriver;
  credentials: Readonly<Record<string, string>>;
  appUrl: string;
  fetch?: FetchLike;
  /** Doar teste: înlocuiește stocarea driverului `s3` (fără cont real). */
  s3Storage?: StorageDriver;
}

export function buildMediaDelivery(input: BuildMediaDeliveryInput): MediaDeliveryProvider {
  const c = input.credentials;
  switch (input.code) {
    case "local":
      return new StorageDeliveryProvider({
        code: "local",
        label: "Local (stocarea platformei, pentru dezvoltare)",
        storage: input.platformStorage,
      });
    case "s3": {
      if (input.s3Storage) {
        return new StorageDeliveryProvider({
          code: "s3",
          label: "S3 (fișiere)",
          storage: input.s3Storage,
        });
      }
      const endpoint = (c["endpoint"] ?? "").trim();
      const bucket = (c["bucket"] ?? "").trim();
      const accessKeyId = (c["accessKeyId"] ?? "").trim();
      const secretAccessKey = c["secretAccessKey"] ?? "";
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        throw new IntegrationError(
          "MEDIA_DELIVERY_NOT_CONFIGURED",
          "Stocarea S3 pentru fișiere digitale nu e configurată complet",
        );
      }
      return new StorageDeliveryProvider({
        code: "s3",
        label: "S3 (fișiere)",
        storage: new S3StorageDriver({
          endpoint,
          region: (c["region"] ?? "").trim() || "us-east-1",
          bucket,
          accessKeyId,
          secretAccessKey,
          forcePathStyle: (c["forcePathStyle"] ?? "true") !== "false",
          appUrl: input.appUrl,
        }),
      });
    }
    case "bunny":
      return new BunnyDeliveryProvider({
        credentials: {
          apiKey: c["apiKey"] ?? "",
          libraryId: c["libraryId"] ?? "",
          tokenAuthKey: c["tokenAuthKey"] ?? "",
        },
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
  }
}
