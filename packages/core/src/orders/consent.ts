/**
 * Consimțământul pentru Termeni la checkout: textul exact și versiunea lui se salvează PE COMANDĂ (cu momentul acceptării).
 * Textul și versiunea vin de aici, de pe server, niciodată de la client; interfața afișează exact acest text.
 *
 * ⚠️ PROVIZORIU: formularea finală și paginile legale reale vin cu avocatul și cu Faza 16 (`docs/INTREBARI-AVOCAT.md` 7.3).
 * Până atunci legăturile duc la pagini provizorii, marcate «în curs de redactare». La orice schimbare a textului se
 * schimbă și `version`, ca o comandă veche să păstreze textul pe care l-a acceptat clientul.
 */
export const CHECKOUT_TERMS_CONSENT = {
  version: "provizoriu-1",
  text: "Am citit și sunt de acord cu Termenii și condițiile și cu Politica de confidențialitate.",
} as const;
