import pino, { type DestinationStream, type Logger } from "pino";
import { getRequestContext } from "./request-context";

/**
 * Câmpuri care nu apar niciodată în loguri: secrete, sesiuni, date de plată, credențiale de
 * integrare și prețul de achiziție (`costPrice` e doar pentru admin, vezi CLAUDE.md).
 * Fiecare nume e acoperit la adâncimile 0-3 (ex. `order.lines.costPrice` → `*.*.costPrice`).
 * Pino nu are wildcard recursiv; un array se numără ca un nivel (`lines[0]` → `*`).
 */
const SENSITIVE_FIELDS = [
  "password",
  "token",
  "apiKey",
  "secret",
  "credentials",
  "authorization",
  "cookie",
  "APP_KEY",
  "costPrice",
  "costPriceDate",
  "costNet",
];

export const REDACT_PATHS = [
  ...SENSITIVE_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`]),
  'headers["authorization"]',
  'headers["cookie"]',
];

export interface LoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.NODE_ENV === "production" ? "info" : "debug");
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: "[ascuns]" },
      // Fiecare linie de log primește automat requestId-ul cererii curente, dacă există.
      mixin: () => getRequestContext() ?? {},
    },
    options.destination,
  );
}

let defaultLogger: Logger | undefined;

/** Loggerul implicit al aplicației (singleton). */
export function getLogger(): Logger {
  defaultLogger ??= createLogger();
  return defaultLogger;
}
