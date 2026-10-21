import { loadEnv } from "@ecom/config";
import { SettingsService, createPrismaSettingsStore, purgeStaleAuthRecords } from "@ecom/core";
import { getDb } from "@ecom/db";
import { getLogger } from "@ecom/shared";
import { Redis } from "ioredis";

/**
 * Programatorul retenției conturilor neverificate (Blocul C, C-02): rulează la pornire (după o scurtă întârziere) și apoi la
 * fiecare `intervalMs`. O rulare care eșuează se loghează și programul continuă; două rulări nu se suprapun. Ștergerile sunt
 * idempotente, deci mai multe procese worker nu se încurcă.
 */

export interface AuthRetentionLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface AuthRetentionOptions {
  run: () => Promise<{ users: number; verifications: number }>;
  logger: AuthRetentionLogger;
  /** Prima rulare, după pornire (implicit un minut: nu încarcă pornirea). */
  initialDelayMs?: number;
  /** Intervalul dintre rulări (implicit 6 ore). */
  intervalMs?: number;
}

export function startAuthRetention(options: AuthRetentionOptions): { close(): void } {
  const { run, logger } = options;
  let running = false;
  let closed = false;

  const tick = async () => {
    if (running || closed) return;
    running = true;
    try {
      const result = await run();
      logger.info(
        result,
        "retenția autentificării: conturi neverificate și verificări expirate șterse",
      );
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "retenția autentificării a eșuat; se reia la următorul interval",
      );
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), options.initialDelayMs ?? 60_000);
  const every = setInterval(() => void tick(), options.intervalMs ?? 6 * 3600 * 1000);
  first.unref?.();
  every.unref?.();
  return {
    close() {
      closed = true;
      clearTimeout(first);
      clearInterval(every);
    },
  };
}

/** Pornește programatorul cu dependențele reale (baza de date, setările). Folosit de `pnpm worker`. */
export function startAuthRetentionFromEnv() {
  const env = loadEnv();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined); // setările cad pe DB
  const db = getDb();
  const settings = new SettingsService(createPrismaSettingsStore(db), redis);
  const handle = startAuthRetention({
    logger: getLogger(),
    run: async () => {
      const auth = await settings.getGroup("auth");
      return purgeStaleAuthRecords(db, {
        requireEmailVerification: auth.requireEmailVerification,
        unverifiedAccountDays: auth.unverifiedAccountRetentionDays,
        emailVerificationHours: auth.emailVerificationHours,
      });
    },
  });
  return {
    close() {
      handle.close();
      redis.disconnect();
    },
  };
}
