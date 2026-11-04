import { DomainError, ValidationError } from "@ecom/shared";
import { AuditService, type AuditStore } from "../audit/audit-service";
import { createWithAudit, type AuditActor } from "../audit/with-audit";
import type { KeyValueCache } from "../cache/read-through";
import {
  FEATURE_FLAGS_CACHE_TTL_SECONDS,
  FeatureFlagService,
  type FeatureFlagState,
  type FeatureFlagStore,
} from "./feature-flag-service";
import { FEATURE_FLAGS, FEATURE_KEYS, isFeatureKey, type FeatureKey } from "./registry";

/**
 * Logica scriptului de dezvoltare `dev:flag` (pornește/oprește un steag de funcționalitate fără ecranul de Setări, care vine
 * în Faza 16). Scriptul din `packages/core/scripts/dev-flag.ts` doar leagă conexiunile; regulile sunt aici, ca să fie testate.
 *
 * Reguli: scrie DOAR prin `FeatureFlagService` (tabelul `feature_flag`) și `AuditService` (tabelul `audit_log`); acceptă doar
 * steaguri din registru; refuză să ruleze dacă baza sau Redis nu sunt pe calculatorul local sau dacă mediul e de producție;
 * nu afișează adrese, utilizatori sau parole.
 */

/** Actorul din jurnalul de audit pentru modificările făcute de script. */
export const DEV_FLAG_ACTOR: AuditActor = { id: "dev-script", label: "script de dezvoltare" };

export type DevFlagCommand =
  { kind: "status" } | { kind: "set"; key: FeatureKey; enabled: boolean };

export type DevFlagResult =
  | { kind: "status"; flags: FeatureFlagState[] }
  | {
      kind: "set";
      key: FeatureKey;
      label: string;
      before: boolean;
      after: boolean;
      changed: boolean;
      /** Cheia din Redis a fost ștearsă (altfel, aplicația vede starea veche până la expirarea cache-ului). */
      cacheCleared: boolean;
    };

const USAGE = "Folosire: npm.cmd run dev:flag -- <steag> on|off   (fără argumente: arată starea)";

/** `dev:flag` → status; `dev:flag <steag> on|off` → setare. Orice altceva e refuzat cu un mesaj clar. */
export function parseDevFlagArgs(args: readonly string[]): DevFlagCommand {
  if (args.length === 0) return { kind: "status" };
  const [key, value, ...extra] = args;
  if (key === undefined || !isFeatureKey(key)) {
    throw new ValidationError(
      `Steag necunoscut: „${key ?? ""}”. Steaguri valide: ${FEATURE_KEYS.join(", ")}. ${USAGE}`,
    );
  }
  const normalized = value?.toLowerCase();
  if ((normalized !== "on" && normalized !== "off") || extra.length > 0) {
    throw new ValidationError(`Cer exact „on” sau „off” după numele steagului. ${USAGE}`);
  }
  return { kind: "set", key, enabled: normalized === "on" };
}

function refuse(message: string): never {
  throw new DomainError("DEV_FLAG_ENVIRONMENT_REFUSED", `Refuz să rulez: ${message}`);
}

/** Gazdele locale. Fără subșiruri: `localhost.example.com` și `127.0.0.1.evil.com` nu sunt locale. */
function isLocalHostName(host: string): boolean {
  const name = host.toLowerCase();
  return (
    name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".localhost")
  );
}

/** Verifică o adresă de conexiune fără să o repete în mesaj (adresa poate conține parola). */
function assertLocalUrl(variable: string, raw: string | undefined): void {
  if (!raw) refuse(`${variable} lipsește.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Mesajul erorii originale conține adresa: nu îl folosim.
    return refuse(`${variable} nu e o adresă validă.`);
  }
  // `?host=…` suprascrie gazda din adresă în driverul Postgres: adresa nu mai e cea care pare.
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
    refuse(`${variable} indică gazda prin parametri; folosește o adresă locală simplă.`);
  }
  if (!isLocalHostName(url.hostname)) {
    refuse(
      `${variable} nu arată spre calculatorul local (scriptul e doar pentru dezvoltare și teste).`,
    );
  }
}

/**
 * Scriptul rulează doar pe baza și pe Redis-ul locale, în afara producției. Aruncă `DEV_FLAG_ENVIRONMENT_REFUSED`, înainte de
 * orice conexiune.
 */
export function assertDevFlagEnvironment(env: Record<string, string | undefined>): void {
  if (env["NODE_ENV"] === "production" || env["APP_ENV"] === "production") {
    refuse("mediul este de producție.");
  }
  assertLocalUrl("DATABASE_URL", env["DATABASE_URL"]);
  assertLocalUrl("REDIS_URL", env["REDIS_URL"]);
}

/** Cache care nu aruncă niciodată (e opțional) și ține minte dacă ultima ștergere a reușit. */
export interface QuietCache extends KeyValueCache {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<undefined>;
  del(key: string): Promise<undefined>;
  /** `null` = nicio ștergere încă. */
  lastDeleteSucceeded(): boolean | null;
}

export function createQuietCache(redis: KeyValueCache): QuietCache {
  let lastDelete: boolean | null = null;
  return {
    async get(key) {
      try {
        return await redis.get(key);
      } catch {
        return null;
      }
    },
    async set(key, value, mode, seconds) {
      try {
        await redis.set(key, value, mode, seconds);
      } catch {
        // cache-ul e opțional
      }
      return undefined;
    },
    async del(key) {
      try {
        await redis.del(key);
        lastDelete = true;
      } catch {
        lastDelete = false;
      }
      return undefined;
    },
    lastDeleteSucceeded: () => lastDelete,
  };
}

/** Fără cache: citește mereu din bază (starea de dinainte și de după vine din adevăr, nu dintr-un cache vechi). */
const NO_CACHE: KeyValueCache = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
};

export interface RunDevFlagDeps {
  command: DevFlagCommand;
  store: FeatureFlagStore;
  redis: KeyValueCache;
  auditStore: AuditStore;
}

export async function runDevFlag({
  command,
  store,
  redis,
  auditStore,
}: RunDevFlagDeps): Promise<DevFlagResult> {
  const fresh = new FeatureFlagService(store, NO_CACHE);
  if (command.kind === "status") return { kind: "status", flags: await fresh.list() };

  const cache = createQuietCache(redis);
  const flags = new FeatureFlagService(store, cache);
  const withAudit = createWithAudit({
    audit: new AuditService(auditStore),
    getActor: async () => DEV_FLAG_ACTOR,
  });
  // Aceeași specificație ca `setFeatureFlag` din admin (`admin-writes.ts`): acțiune, entitate, diferențe înainte/după.
  const setAudited = withAudit(
    {
      action: "feature_flag.update",
      entity: "feature_flag",
      entityId: (input: { key: FeatureKey; enabled: boolean }) => input.key,
      before: async (input) => ({ enabled: await fresh.isEnabled(input.key) }),
      diff: true,
    },
    async (input) => {
      // `setEnabled` scrie rândul și șterge imediat cache-ul din Redis.
      await flags.setEnabled(input.key, input.enabled);
      return { enabled: await fresh.isEnabled(input.key) };
    },
  );

  const before = await fresh.isEnabled(command.key);
  const { enabled: after } = await setAudited({ key: command.key, enabled: command.enabled });
  return {
    kind: "set",
    key: command.key,
    label: FEATURE_FLAGS[command.key],
    before,
    after,
    changed: before !== after,
    cacheCleared: cache.lastDeleteSucceeded() === true,
  };
}

const stateText = (enabled: boolean): string => (enabled ? "pornit" : "oprit");

/** Liniile afișate de script. Doar numele steagului și starea lui; nimic din mediu. */
export function formatDevFlagResult(result: DevFlagResult): string[] {
  if (result.kind === "status") {
    const width = Math.max(...result.flags.map((flag) => flag.key.length)) + 2;
    return [
      "Starea steagurilor:",
      ...result.flags.map(
        (flag) => `  ${flag.key.padEnd(width)}${flag.label} — ${stateText(flag.enabled)}`,
      ),
    ];
  }
  const head = result.changed
    ? `Steagul ${result.key} (${result.label}): ${stateText(result.before)} → ${stateText(result.after)}.`
    : `Steagul ${result.key} (${result.label}) era deja ${stateText(result.after)}; nu s-a schimbat nimic.`;
  const cache = result.cacheCleared
    ? "Cache-ul Redis al steagurilor a fost șters; schimbarea se vede la următoarea cerere, fără repornirea serverului."
    : `⚠ Cache-ul Redis nu a putut fi șters: aplicația poate arăta starea veche până la ${FEATURE_FLAGS_CACHE_TTL_SECONDS / 60} minute.`;
  return [head, cache];
}
