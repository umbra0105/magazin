import pino, { type DestinationStream, type Logger } from "pino";
import { getRequestContext } from "./request-context";

/** Câmpuri care nu apar niciodată în loguri (secrete, sesiuni, date de plată). */
export const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "secret",
  "*.secret",
  "credentials",
  "*.credentials",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
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
