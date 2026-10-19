/** Data și ora în fusul magazinului (`regional.timezone`) și în limba lui (`regional.locale`). */
export function formatDateTime(date: Date | string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(typeof date === "string" ? new Date(date) : date);
}
