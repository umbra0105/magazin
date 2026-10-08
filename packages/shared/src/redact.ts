/** Valoarea care înlocuiește orice câmp sensibil, în loguri și în jurnalul de audit. */
export const REDACTED = "[ascuns]";

/**
 * Câmpuri care nu apar niciodată în loguri sau în audit: secrete, sesiuni, date de plată,
 * credențiale de integrare și prețul de achiziție (`costPrice` e doar pentru admin, vezi CLAUDE.md).
 */
export const SENSITIVE_FIELDS = [
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
] as const;

const EXACT = new Set(SENSITIVE_FIELDS.map((field) => field.toLowerCase()));

/** Fragmente care fac sensibil orice nume de câmp care le conține (accessToken, clientSecret...). */
const FRAGMENTS = [
  "password",
  "token",
  "secret",
  "apikey",
  "credential",
  "authorization",
  "cookie",
];

/** Un nume de câmp e sensibil dacă e în listă sau conține un fragment sensibil (fără majuscule). */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return EXACT.has(lower) || lower === "appkey" || FRAGMENTS.some((f) => lower.includes(f));
}

/**
 * Copie a lui `value` în care orice câmp sensibil, la orice adâncime, are valoarea `[ascuns]`.
 * Nu modifică originalul. Tratează obiecte, array-uri, Date și referințe circulare.
 */
export function redactSensitive(value: unknown): unknown {
  return redact(value, new WeakSet());
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(inner, seen);
  }
  return out;
}
