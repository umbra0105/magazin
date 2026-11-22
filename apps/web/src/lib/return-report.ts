/**
 * Perioada raportului de motive: «AAAA-LL-ZZ» (text, fără calendar nativ). «De la» începe la 00:00:00 UTC, «până la» include toată
 * ziua (până la 23:59:59.999 UTC). Un text care nu e o dată calendaristică reală dă `ok: false` (interfața arată mesajul propriu).
 */
export interface ReportDates {
  ok: boolean;
  from?: Date;
  to?: Date;
  fromText: string;
  toText: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(text: string): Date | null {
  const match = DAY.exec(text);
  if (!match) return null;
  const [y, mo, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    ? date
    : null;
}

export function parseReportDates(from: string | undefined, to: string | undefined): ReportDates {
  const fromText = (from ?? "").trim().slice(0, 10);
  const toText = (to ?? "").trim().slice(0, 10);
  const start = fromText === "" ? null : parseDay(fromText);
  const end = toText === "" ? null : parseDay(toText);
  const ok = (fromText === "" || start !== null) && (toText === "" || end !== null);
  return {
    ok,
    ...(start ? { from: start } : {}),
    ...(end ? { to: new Date(end.getTime() + 24 * 60 * 60 * 1000 - 1) } : {}),
    fromText,
    toText,
  };
}
