import { loadEnv } from "@ecom/config";
import {
  DeliveryConfigService,
  type AccessDeps,
  type ContentDeps,
  type DigitalSettings,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getStorage } from "./media";
import { getSettings } from "./services";

/**
 * Produsele digitale pe partea de aplicație (Faza 14b): configurarea livrării (chei criptate, garda «confirmat de Owner»), setările
 * `digital.*` și dependențele serviciilor din `@ecom/core`. Logica rămâne în `@ecom/core`; aici doar firele.
 */
const globalForDigital = globalThis as unknown as { __ecomDeliveryConfig?: DeliveryConfigService };

export function getDeliveryConfig(): DeliveryConfigService {
  globalForDigital.__ecomDeliveryConfig ??= new DeliveryConfigService({
    db: getDb(),
    appKey: loadEnv().APP_KEY,
    appUrl: loadEnv().APP_URL,
    platformStorage: getStorage(),
  });
  return globalForDigital.__ecomDeliveryConfig;
}

export async function readDigitalGroup(): Promise<DigitalSettings> {
  return (await getSettings().getGroup("digital")) as DigitalSettings;
}

/** Dependențele emiterii linkurilor de acces (clientul, previzualizarea): setările și driverele cu garda lor. */
export function getDigitalAccessDeps(): AccessDeps {
  return {
    db: getDb(),
    readSettings: async () => {
      const s = await readDigitalGroup();
      return {
        linkSeconds: s.linkSeconds,
        maxIpsPerEntitlement: s.maxIpsPerEntitlement,
        ipWindowHours: s.ipWindowHours,
      };
    },
    getProvider: (code) => getDeliveryConfig().provider(code),
  };
}

/** Dependențele editării conținutului din admin (încărcare, ștergere, stare). */
export function getDigitalContentDeps(): ContentDeps {
  return { db: getDb(), getProvider: (code) => getDeliveryConfig().provider(code) };
}
