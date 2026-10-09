import { Inter, Lora, Manrope, Montserrat, Open_Sans, Playfair_Display } from "next/font/google";

/**
 * Fonturile permise în temă (lista din `FONT_FAMILIES`, packages/core/src/branding/tokens.ts).
 * `next/font` le descarcă LA BUILD și le servește de pe domeniul magazinului: browserul nu face
 * nicio cerere către Google sau alt CDN. Variabila fiecărui font trebuie să corespundă cu
 * `cssVar` din `FONT_FAMILIES` (verificat de `fonts.test.ts`).
 *
 * next/font cere obiecte literale (fără spread), de aceea opțiunile se repetă.
 * `latin-ext` e necesar pentru diacriticele românești ș și ț. `preload: false`: nu preîncărcăm
 * toate cele șase familii pe fiecare pagină; browserul descarcă doar fișierul familiei folosite.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
});
const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
});
const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
});
const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
});
const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
});
const playfairDisplay = Playfair_Display({
  variable: "--font-playfair-display",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
});

/** Clasele care declară toate variabilele de font, puse pe <html>. */
export const fontVariableClasses = [inter, manrope, montserrat, openSans, lora, playfairDisplay]
  .map((font) => font.variable)
  .join(" ");
