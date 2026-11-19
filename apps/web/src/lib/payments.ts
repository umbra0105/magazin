import { loadEnv } from "@ecom/config";
import {
  CardPaymentService,
  PaymentConfigService,
  createSystemPaymentAudit,
  readDemoGuardEnv,
  type PaymentProcessorDeps,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { createPaymentQueue, enqueuePaymentEvent, type PaymentQueue } from "@ecom/jobs";
import { getSettings } from "./services";

/**
 * Plățile cu cardul pe partea de aplicație (Faza 10): configurarea furnizorilor (credențiale criptate, mod test/live,
 * garda «verificat în sandbox»), citită din baza de date la fiecare cerere. Logica rămâne în `@ecom/core`.
 */
const globalForPayments = globalThis as unknown as {
  __ecomPaymentConfig?: PaymentConfigService;
  __ecomPaymentQueue?: PaymentQueue;
};

const ENQUEUE_TIMEOUT_MS = 3000;

export function getPaymentConfig(): PaymentConfigService {
  if (!globalForPayments.__ecomPaymentConfig) {
    globalForPayments.__ecomPaymentConfig = new PaymentConfigService({
      db: getDb(),
      appKey: loadEnv().APP_KEY,
      env: readDemoGuardEnv(),
      readCardProvider: async () => (await getSettings().getGroup("payment")).cardProvider,
    });
  }
  return globalForPayments.__ecomPaymentConfig;
}

/** O singură coadă (și conexiune Redis) per proces; o eroare de conexiune nu oprește procesul (măturătorul preia evenimentele). */
function getPaymentQueue(): PaymentQueue {
  if (!globalForPayments.__ecomPaymentQueue) {
    const queue = createPaymentQueue(loadEnv().REDIS_URL);
    queue.on("error", () => undefined);
    globalForPayments.__ecomPaymentQueue = queue;
  }
  return globalForPayments.__ecomPaymentQueue;
}

/** Dependențele ingerării și procesării notificărilor de plată (ruta webhook și acțiunile de admin). */
export function getPaymentProcessorDeps(): PaymentProcessorDeps {
  const db = getDb();
  const config = getPaymentConfig();
  return {
    db,
    getProvider: (code) => config.getProvider(code),
    now: () => new Date(),
    enqueue: async (eventId) => {
      await Promise.race([
        enqueuePaymentEvent(getPaymentQueue(), eventId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout la punerea în coadă")), ENQUEUE_TIMEOUT_MS),
        ),
      ]);
    },
    markVerifiedInSandbox: (code) => config.markVerifiedInSandbox(code),
    audit: createSystemPaymentAudit(db),
  };
}

/** Plata cu cardul pe partea comenzii: inițiere, reîncercare, starea paginilor. Adresele vin din `APP_URL`. */
export function getCardPayments(): CardPaymentService {
  const config = getPaymentConfig();
  const origin = new URL(loadEnv().APP_URL).origin;
  return new CardPaymentService({
    db: getDb(),
    getProvider: (code) => config.getProvider(code),
    readSettings: async () => {
      const settings = getSettings();
      const [inventory, regional, payment] = await Promise.all([
        settings.getGroup("inventory"),
        settings.getGroup("regional"),
        settings.getGroup("payment"),
      ]);
      return {
        reservationMinutes: inventory.reservationMinutes,
        transferReservationWorkdays: inventory.transferReservationWorkdays,
        timeZone: regional.timezone,
        nonWorkingDates: regional.nonWorkingDates,
        cardRetryHours: payment.cardRetryHours,
        cardProvider: await config.activeCardProvider(),
      };
    },
    now: () => new Date(),
    returnUrl: (paymentId) => `${origin}/comanda/plata/${encodeURIComponent(paymentId)}`,
    notifyUrl: (provider) => `${origin}/api/webhooks/payments/${encodeURIComponent(provider)}`,
  });
}
