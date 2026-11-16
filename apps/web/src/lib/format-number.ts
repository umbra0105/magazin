/**
 * Numerele din vitrină (intervale de filtre, chip-uri, glisoare, valori) în forma limbii magazinului: în română, virgulă
 * zecimală («2,5 kW», nu «2.5 kW»). Un singur loc, ca filtrele, chip-urile și glisoarele să nu diverge.
 */
export function formatNumber(value: number, locale: string, maximumFractionDigits = 4): string {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

/** Numărul ca text editabil, fără separator de mii («12,5»): pentru câmpurile de interval, pe care serverul le citește cu virgulă. */
export function formatEditableNumber(value: number): string {
  return String(value).replace(".", ",");
}

/** Textul tastat într-un câmp numeric («12,5» sau «12.5») → număr; `null` dacă nu e încă un număr. */
export function parseEditableNumber(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Intervalul ales, pentru chip: «2,5–12 kW», «≥ 2,5 kW» sau «≤ 12 kW». */
export function formatRange(
  range: { min: number | null; max: number | null },
  unit: string | null,
  locale: string,
): string {
  const suffix = unit ? ` ${unit}` : "";
  const { min, max } = range;
  if (min !== null && max !== null) {
    return `${formatNumber(min, locale)}–${formatNumber(max, locale)}${suffix}`;
  }
  if (min !== null) return `≥ ${formatNumber(min, locale)}${suffix}`;
  if (max !== null) return `≤ ${formatNumber(max, locale)}${suffix}`;
  return "";
}
