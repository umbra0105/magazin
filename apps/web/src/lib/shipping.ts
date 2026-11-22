import { loadEnv } from "@ecom/config";
import { CarrierConfigService, CarrierRuntime, readDemoGuardEnv } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getSettings } from "./services";

/**
 * Curierii pe partea de aplicație (Faza 12): configurarea (credențiale criptate, mod test/live, garda «testat cu cont real») și
 * curierii în execuție (întrerupător de circuit pe curier, cache de tarife), un exemplar per proces. Logica stă în `@ecom/core`.
 */
const globalForShipping = globalThis as unknown as {
  __ecomCarrierConfig?: CarrierConfigService;
  __ecomCarrierRuntime?: CarrierRuntime;
};

export function getCarrierConfig(): CarrierConfigService {
  globalForShipping.__ecomCarrierConfig ??= new CarrierConfigService({
    db: getDb(),
    appKey: loadEnv().APP_KEY,
    env: readDemoGuardEnv(),
    readSelected: async () => (await getSettings().getGroup("shipping")).carrier,
  });
  return globalForShipping.__ecomCarrierConfig;
}

export function getCarrierRuntime(): CarrierRuntime {
  globalForShipping.__ecomCarrierRuntime ??= new CarrierRuntime({
    source: getCarrierConfig(),
    readCacheSeconds: async () => (await getSettings().getGroup("shipping")).rateCacheSeconds,
  });
  return globalForShipping.__ecomCarrierRuntime;
}
