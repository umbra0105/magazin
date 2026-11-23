import { getSettings } from "./services";
import { getStorefrontFormat } from "./storefront-catalog";
import { formatDateTime } from "./format-date";
import { formatMoney } from "./money-input";

/** Formatarea banilor și a datelor în contul clientului: moneda și limba magazinului, fusul din setări (nimic hardcodat). */
export interface AccountFormat {
  money: (minor: number) => string;
  dateTime: (date: Date | string) => string;
  date: (date: Date | string) => string;
}

export async function getAccountFormat(): Promise<AccountFormat> {
  const [format, regional] = await Promise.all([
    getStorefrontFormat(),
    getSettings().getGroup("regional"),
  ]);
  const timeZone = regional.timezone;
  return {
    money: (minor) => formatMoney(minor, format.currency, format.locale),
    dateTime: (date) => formatDateTime(date, format.locale, timeZone),
    date: (date) =>
      new Intl.DateTimeFormat(format.locale, { dateStyle: "long", timeZone }).format(
        typeof date === "string" ? new Date(date) : date,
      ),
  };
}
