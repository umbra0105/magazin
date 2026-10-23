import { describe, expect, it } from "vitest";
import { localDateTime, zonedLocalToUtc } from "@ecom/shared";
import { addWorkdaysEndOfDay, reservationExpiresAt } from "./workdays";

const BUCHAREST = "Europe/Bucharest";
const at = (text: string): Date => new Date(text);

/** Ziua locală (an-lună-zi) a unui moment, ca text, ca să comparăm calendarul și nu orele. */
function localDay(instant: Date, timeZone: string): string {
  const l = localDateTime(instant, timeZone);
  return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
}

describe("N-a zi lucrătoare după ziua comenzii, la sfârșitul zilei", () => {
  // 2026-10-23 e vineri; 25 octombrie 2026 e ultima duminică din octombrie (trecerea la ora de iarnă)
  const cases: Array<[string, string, number, string]> = [
    ["vineri 15:00, 3 zile → miercuri", "2026-10-23T12:00:00Z", 3, "2026-10-28"],
    ["sâmbătă, 3 zile → miercuri", "2026-10-24T07:00:00Z", 3, "2026-10-28"],
    ["duminică, 3 zile → miercuri", "2026-10-25T10:00:00Z", 3, "2026-10-28"],
    ["luni, 3 zile → joi", "2026-10-26T07:00:00Z", 3, "2026-10-29"],
    ["miercuri, 3 zile → luni (peste weekend)", "2026-10-28T07:00:00Z", 3, "2026-11-02"],
    ["vineri, 1 zi → luni", "2026-10-23T12:00:00Z", 1, "2026-10-26"],
    ["luni, 5 zile → luni următoare", "2026-10-26T07:00:00Z", 5, "2026-11-02"],
    ["luni, 10 zile → a doua luni următoare", "2026-10-26T07:00:00Z", 10, "2026-11-09"],
    [
      "peste sfârșit de an (fără sărbători): miercuri 30 dec, 3 zile → luni 4 ian",
      "2026-12-30T10:00:00Z",
      3,
      "2027-01-04",
    ],
    [
      "peste schimbarea orei de primăvară: vineri 26 mar 2027, 3 zile → miercuri",
      "2027-03-26T10:00:00Z",
      3,
      "2027-03-31",
    ],
  ];
  it.each(cases)("%s", (_name, from, workdays, expectedDay) => {
    const expiry = addWorkdaysEndOfDay(at(from), workdays, BUCHAREST);
    expect(localDay(expiry, BUCHAREST)).toBe(expectedDay);
    expect(localDateTime(expiry, BUCHAREST)).toMatchObject({
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    });
  });

  it("momentul exact: miercuri la 23:59:59.999 locală, deci 21:59:59.999 UTC după trecerea la ora de iarnă", () => {
    expect(addWorkdaysEndOfDay(at("2026-10-23T12:00:00Z"), 3, BUCHAREST).toISOString()).toBe(
      "2026-10-28T21:59:59.999Z",
    );
    // după trecerea la ora de vară (UTC+3): 20:59:59.999 UTC
    expect(addWorkdaysEndOfDay(at("2027-03-26T10:00:00Z"), 3, BUCHAREST).toISOString()).toBe(
      "2027-03-31T20:59:59.999Z",
    );
  });

  it("ora din zi a comenzii nu contează, dar ZIUA LOCALĂ contează: duminică 23:30 locală ≠ luni 00:30 locală", () => {
    // 2026-11-01 e duminică; 23:30 locală = 21:30 UTC; 00:30 locală de luni = 22:30 UTC (aceeași zi UTC!)
    const sunday = addWorkdaysEndOfDay(at("2026-11-01T21:30:00Z"), 3, BUCHAREST);
    const monday = addWorkdaysEndOfDay(at("2026-11-01T22:30:00Z"), 3, BUCHAREST);
    expect(localDay(sunday, BUCHAREST)).toBe("2026-11-04");
    expect(localDay(monday, BUCHAREST)).toBe("2026-11-05");
  });

  it("exact după miezul nopții, la sfârșitul zilei de dinainte: ultima milisecundă se ține, următoarea nu", () => {
    const expiry = addWorkdaysEndOfDay(at("2026-10-23T12:00:00Z"), 3, BUCHAREST);
    const nextInstant = new Date(expiry.getTime() + 1);
    expect(localDateTime(nextInstant, BUCHAREST)).toMatchObject({ day: 29, hour: 0, minute: 0 });
  });

  it("calculul se face în fusul cerut, nu în cel al serverului", () => {
    // duminică 2026-11-01 la 22:30 UTC: luni 00:30 la București, încă duminică 17:30 la New York, luni 11:30 la Auckland
    const instant = at("2026-11-01T22:30:00Z");
    expect(localDay(addWorkdaysEndOfDay(instant, 1, BUCHAREST), BUCHAREST)).toBe("2026-11-03");
    expect(localDay(addWorkdaysEndOfDay(instant, 1, "America/New_York"), "America/New_York")).toBe(
      "2026-11-02",
    );
    expect(localDay(addWorkdaysEndOfDay(instant, 1, "Pacific/Auckland"), "Pacific/Auckland")).toBe(
      "2026-11-03",
    );
  });

  /**
   * Referință INDEPENDENTĂ (formă închisă, fără buclă pe zile): dintr-o zi lucrătoare cu indicele k (luni = 0 … vineri = 4)
   * se avansează n zile lucrătoare → săptămâni = ⌊(k + n) / 5⌋, ziua = (k + n) mod 5; dintr-un weekend se pornește de la vinerea
   * dinainte (k = 4). Calendar calculat cu Date.UTC pe data locală.
   */
  function expectedLocalDay(
    local: { year: number; month: number; day: number; weekday: number },
    n: number,
  ): string {
    const weekdayIndex = local.weekday - 1; // luni = 0 … duminică = 6
    const k = Math.min(weekdayIndex, 4);
    const backToFriday = weekdayIndex > 4 ? weekdayIndex - 4 : 0;
    const total = k + n;
    const calendarDays = Math.floor(total / 5) * 7 + (total % 5) - k - backToFriday;
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + calendarDays));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  it("coincide cu referința în formă închisă pe 2400 de momente × 30 de durate, în 3 fusuri", () => {
    let seed = 13579;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (const zone of [BUCHAREST, "UTC", "America/New_York"]) {
      for (let i = 0; i < 800; i++) {
        const from = new Date(Date.UTC(2026, 0, 1) + (next() % (3 * 365 * 24 * 3600)) * 1000);
        const n = 1 + (next() % 30);
        const expiry = addWorkdaysEndOfDay(from, n, zone);
        expect(localDay(expiry, zone), `${zone} ${from.toISOString()} +${n}`).toBe(
          expectedLocalDay(localDateTime(from, zone), n),
        );
        expect(localDateTime(expiry, zone)).toMatchObject({
          hour: 23,
          minute: 59,
          second: 59,
          millisecond: 999,
        });
        // și ultima milisecundă a zilei: următoarea e miezul nopții
        expect(localDateTime(new Date(expiry.getTime() + 1), zone)).toMatchObject({
          hour: 0,
          minute: 0,
          second: 0,
          millisecond: 0,
        });
      }
    }
  });

  it("e mereu într-o zi lucrătoare și strict după comandă", () => {
    for (let day = 0; day < 60; day++) {
      const from = new Date(Date.UTC(2026, 9, 1 + day, 9, 0));
      const expiry = addWorkdaysEndOfDay(from, 3, BUCHAREST);
      expect(expiry.getTime()).toBeGreaterThan(from.getTime());
      expect(localDateTime(expiry, BUCHAREST).weekday).toBeLessThanOrEqual(5);
    }
  });

  it("argumente nevalide → RangeError", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 366]) {
      expect(
        () => addWorkdaysEndOfDay(at("2026-10-23T12:00:00Z"), bad, BUCHAREST),
        String(bad),
      ).toThrow(RangeError);
    }
    expect(() => addWorkdaysEndOfDay(at("2026-10-23T12:00:00Z"), 3, "Marte/Olympus")).toThrow(
      RangeError,
    );
    expect(() => addWorkdaysEndOfDay(new Date("x"), 3, BUCHAREST)).toThrow(RangeError);
  });
});

describe("expirarea rezervării după metoda de plată (D4)", () => {
  const settings = { reservationMinutes: 15, transferReservationWorkdays: 3, timeZone: BUCHAREST };
  const now = at("2026-10-23T12:00:00Z");

  it("card: acum + reservationMinutes", () => {
    expect(reservationExpiresAt("card", now, settings).toISOString()).toBe(
      "2026-10-23T12:15:00.000Z",
    );
    expect(
      reservationExpiresAt("card", now, { ...settings, reservationMinutes: 1 }).toISOString(),
    ).toBe("2026-10-23T12:01:00.000Z");
  });

  it("transfer bancar: sfârșitul celei de-a N-a zile lucrătoare, cu N din setări", () => {
    expect(reservationExpiresAt("transfer", now, settings).toISOString()).toBe(
      "2026-10-28T21:59:59.999Z",
    );
    expect(
      reservationExpiresAt("transfer", now, {
        ...settings,
        transferReservationWorkdays: 1,
      }).toISOString(),
    ).toBe("2026-10-26T21:59:59.999Z");
  });

  it("setări nevalide sau metodă necunoscută → RangeError (nu un termen ghicit)", () => {
    expect(() => reservationExpiresAt("card", now, { ...settings, reservationMinutes: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      reservationExpiresAt("card", now, { ...settings, reservationMinutes: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      reservationExpiresAt("transfer", now, { ...settings, transferReservationWorkdays: 0 }),
    ).toThrow(RangeError);
    // ramburs și voucher nu rezervă (ramburs angajează direct): nu există un termen
    expect(() => reservationExpiresAt("cash_on_delivery" as never, now, settings)).toThrow(
      RangeError,
    );
  });

  it("zonedLocalToUtc e inversul ei: sfârșitul zilei se reconstituie din ora locală", () => {
    const expiry = reservationExpiresAt("transfer", now, settings);
    const local = localDateTime(expiry, BUCHAREST);
    expect(zonedLocalToUtc(local, BUCHAREST).getTime()).toBe(expiry.getTime());
  });
});
