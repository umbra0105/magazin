/**
 * Codul stabil al unei erori de domeniu (`PAYMENT_*`, `REFUND_*`…), citit din formă, nu din `instanceof`: modulele din
 * `@ecom/core` pot ajunge în mai multe pachete ale build-ului, iar atunci clasa erorii diferă de la o rută la alta și
 * `instanceof` dă fals. Întoarce `null` dacă eroarea nu are cod de acest fel.
 */
export function errorCodeOf(error: unknown, prefixes: readonly string[]): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && prefixes.some((prefix) => code.startsWith(prefix))
    ? code
    : null;
}
