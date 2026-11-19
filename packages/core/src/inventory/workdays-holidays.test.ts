import { describe, expect, it } from "vitest";
import { localDateTime } from "@ecom/shared";
import { settingGroups } from "../settings/registry";
import { addWorkdaysEndOfDay, reservationExpiresAt } from "./workdays";

/**
 * Calendarul zilelor nelucrătoare (mutat din Faza 10 în Faza 9): `regional.nonWorkingDates` (date locale `AAAA-LL-ZZ`) se
 * sar la numărarea zilelor lucrătoare, ca un transfer bancar să nu expire cu o zi mai devreme în jurul sărbătorilor.
 * Intrări explicite ale unei funcții pure (nu depind de ceasul real).
 */
const BUCHAREST = "Europe/Bucharest";
const at = (text: string): Date => new Date(text);
// vineri 2026-10-23, la prânz
const FRIDAY = at("2026-10-23T12:00:00Z");

function localDay(instant: Date): string {
  const l = localDateTime(instant, BUCHAREST);
  return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
}

describe("addWorkdaysEndOfDay cu zile nelucrătoare", () => {
  it("fără listă, comportamentul rămâne luni–vineri (vineri + 3 → miercuri)", () => {
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST))).toBe("2026-10-28");
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, []))).toBe("2026-10-28");
  });

  it("o sărbătoare într-o zi lucrătoare mută termenul cu o zi (marți 27 nelucrătoare → joi 29)", () => {
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-27"]))).toBe("2026-10-29");
  });

  it("zile nelucrătoare consecutive se sar toate (luni 26 și marți 27 → vineri 30)", () => {
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-26", "2026-10-27"]))).toBe(
      "2026-10-30",
    );
  });

  it("sărbătoarea chiar în ziua în care ar expira mută termenul (miercuri 28 → joi 29)", () => {
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-28"]))).toBe("2026-10-29");
  });

  it("o dată care pică în weekend nu schimbă nimic (sâmbătă 24)", () => {
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-24"]))).toBe("2026-10-28");
  });

  it("sărbătoarea de după termen nu are efect (joi 29)", () => {
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-29"]))).toBe("2026-10-28");
  });

  it("ziua comenzii nu se numără, chiar dacă e sărbătoare (comandă într-o zi nelucrătoare)", () => {
    // vineri 23 e declarată nelucrătoare: se numără tot de la luni
    expect(localDay(addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-23"]))).toBe("2026-10-28");
  });

  it("un weekend lung cu sărbătoare lipită (vineri 30 oct nelucrătoare, comandă joi 29)", () => {
    // joi 29 + 1 zi lucrătoare: vineri 30 e sărbătoare, sâmbătă/duminică nu contează → luni 2 nov
    const thursday = at("2026-10-29T09:00:00Z");
    expect(localDay(addWorkdaysEndOfDay(thursday, 1, BUCHAREST, ["2026-10-30"]))).toBe(
      "2026-11-02",
    );
  });

  it("lista poate fi nesortată și cu dubluri; data e cea LOCALĂ din fusul magazinului", () => {
    expect(
      localDay(
        addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-27", "2026-10-26", "2026-10-27"]),
      ),
    ).toBe("2026-10-30");
  });

  it("sfârșitul zilei rămâne 23:59:59.999 locală și după sărit", () => {
    const expiry = addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, ["2026-10-27"]);
    expect(localDateTime(expiry, BUCHAREST)).toMatchObject({
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    });
  });

  it("o dată nevalidă în listă → RangeError (nu se ignoră în tăcere)", () => {
    for (const bad of ["2026-13-01", "2026-02-30", "26-10-27", "2026-1-5", "azi", ""]) {
      expect(() => addWorkdaysEndOfDay(FRIDAY, 3, BUCHAREST, [bad]), bad).toThrow(RangeError);
    }
  });
});

describe("reservationExpiresAt transfer cu calendar", () => {
  const settings = {
    reservationMinutes: 15,
    transferReservationWorkdays: 3,
    timeZone: BUCHAREST,
  };

  it("folosește zilele nelucrătoare din setări pentru transfer", () => {
    const expiry = reservationExpiresAt("transfer", FRIDAY, {
      ...settings,
      nonWorkingDates: ["2026-10-27"],
    });
    expect(localDay(expiry)).toBe("2026-10-29");
  });

  it("cardul nu e influențat de calendar", () => {
    expect(
      reservationExpiresAt("card", FRIDAY, {
        ...settings,
        nonWorkingDates: ["2026-10-23"],
      }).toISOString(),
    ).toBe("2026-10-23T12:15:00.000Z");
  });

  it("calendarul lipsă înseamnă luni–vineri (compatibil cu apelurile vechi)", () => {
    expect(localDay(reservationExpiresAt("transfer", FRIDAY, settings))).toBe("2026-10-28");
  });
});

describe("setarea regional.nonWorkingDates", () => {
  const schema = settingGroups.regional.nonWorkingDates;

  it("implicit lista e goală", () => {
    expect(schema.parse(undefined)).toEqual([]);
  });

  it("acceptă date calendaristice AAAA-LL-ZZ valide", () => {
    expect(schema.safeParse(["2026-12-25", "2027-01-01"]).success).toBe(true);
  });

  it("respinge date nevalide, ca text liber sau ca zi inexistentă", () => {
    for (const bad of [
      ["2026-13-01"],
      ["2026-02-30"],
      ["25.12.2026"],
      ["2026-1-1"],
      [""],
      "2026-12-25",
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("limitează numărul de date (plafon anti-abuz)", () => {
    const many = Array.from({ length: 401 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    );
    expect(schema.safeParse(many).success).toBe(false);
  });
});
