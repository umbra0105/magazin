import pino, { type DestinationStream, type Logger } from "pino";
import { REDACTED, SENSITIVE_FIELDS } from "./redact";
import { getRequestContext } from "./request-context";

/**
 * Lista câmpurilor sensibile e în `redact.ts` (comună cu jurnalul de audit). Pino nu are wildcard
 * recursiv, deci fiecare nume e acoperit la adâncimile 0-3 (ex. `order.lines.costPrice` →
 * `*.*.costPrice`); un array se numără ca un nivel (`lines[0]` → `*`).
 */
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
      redact: { paths: REDACT_PATHS, censor: REDACTED },
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
