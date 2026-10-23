import { describe, expect, it } from "vitest";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  parseLocalDateTime,
} from "./stock-time";

const BUCHAREST = "Europe/Bucharest";

describe("data și ora introduse în ora magazinului", () => {
  it("vară (UTC+3) și iarnă (UTC+2)", () => {
    const summer = parseLocalDateTime("23.10.2026", "14:30", BUCHAREST);
    expect(summer).toMatchObject({ ok: true });
    expect(summer.ok && summer.date.toISOString()).toBe("2026-10-23T11:30:00.000Z");
    const winter = parseLocalDateTime("15.01.2027", "09:05", BUCHAREST);
    expect(winter.ok && winter.date.toISOString()).toBe("2027-01-15T07:05:00.000Z");
  });

  it("acceptă zi și lună fără zero în față și separatorul «/» sau «-»; ora cu punct", () => {
    for (const date of ["1.2.2027", "01.02.2027", "1/2/2027", "1-2-2027"]) {
      const result = parseLocalDateTime(date, "8:05", BUCHAREST);
      expect(result.ok && result.date.toISOString(), date).toBe("2027-02-01T06:05:00.000Z");
    }
    const dotted = parseLocalDateTime("01.02.2027", "8.05", BUCHAREST);
    expect(dotted.ok && dotted.date.toISOString()).toBe("2027-02-01T06:05:00.000Z");
  });

  it("spațiile din jur se ignoră", () => {
    expect(parseLocalDateTime("  23.10.2026 ", " 14:30  ", BUCHAREST).ok).toBe(true);
  });

  it("data inexistentă în calendar se refuză (31 februarie, 29 februarie într-un an obișnuit)", () => {
    for (const date of [
      "31.02.2026",
      "29.02.2027",
      "00.01.2026",
      "32.01.2026",
      "10.13.2026",
      "10.00.2026",
    ]) {
      expect(parseLocalDateTime(date, "10:00", BUCHAREST), date).toEqual({
        ok: false,
        field: "date",
        error: "invalid",
      });
    }
    expect(parseLocalDateTime("29.02.2028", "10:00", BUCHAREST).ok).toBe(true);
  });

  it("formate nerecunoscute pentru dată", () => {
    for (const date of [
      "2026-10-23",
      "23.10.26",
      "23 octombrie 2026",
      "23.10",
      "abc",
      "23.10.2026.1",
    ]) {
      expect(parseLocalDateTime(date, "10:00", BUCHAREST), date).toEqual({
        ok: false,
        field: "date",
        error: "invalid",
      });
    }
    expect(parseLocalDateTime("", "10:00", BUCHAREST)).toEqual({
      ok: false,
      field: "date",
      error: "required",
    });
    expect(parseLocalDateTime("  ", "10:00", BUCHAREST)).toEqual({
      ok: false,
      field: "date",
      error: "required",
    });
  });

  it("anii în afara intervalului 2000–2100 se refuză", () => {
    expect(parseLocalDateTime("01.01.1999", "10:00", BUCHAREST)).toMatchObject({
      ok: false,
      field: "date",
    });
    expect(parseLocalDateTime("01.01.2101", "10:00", BUCHAREST)).toMatchObject({
      ok: false,
      field: "date",
    });
    expect(parseLocalDateTime("01.01.2000", "10:00", BUCHAREST).ok).toBe(true);
    expect(parseLocalDateTime("31.12.2100", "10:00", BUCHAREST).ok).toBe(true);
  });

  it("ora: 00:00–23:59; altfel se refuză", () => {
    for (const time of ["24:00", "12:60", "1230", "12:5", "ab:cd", "12:30:00", "-1:00"]) {
      expect(parseLocalDateTime("23.10.2026", time, BUCHAREST), time).toEqual({
        ok: false,
        field: "time",
        error: "invalid",
      });
    }
    expect(parseLocalDateTime("23.10.2026", "", BUCHAREST)).toEqual({
      ok: false,
      field: "time",
      error: "required",
    });
    expect(parseLocalDateTime("23.10.2026", "00:00", BUCHAREST).ok).toBe(true);
    expect(parseLocalDateTime("23.10.2026", "23:59", BUCHAREST).ok).toBe(true);
  });

  it("data greșită se raportează înaintea orei greșite (focusul merge pe primul câmp)", () => {
    expect(parseLocalDateTime("31.02.2026", "99:99", BUCHAREST)).toMatchObject({ field: "date" });
  });

  it("ora care nu există (salt de primăvară) și ora repetată (toamnă) se rezolvă fără eroare", () => {
    // 2027-03-28 03:30 nu există la București → 04:30 locală (01:30 UTC)
    const gap = parseLocalDateTime("28.03.2027", "03:30", BUCHAREST);
    expect(gap.ok && gap.date.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    // 2026-10-25 03:30 apare de două ori → prima apariție (00:30 UTC)
    const overlap = parseLocalDateTime("25.10.2026", "03:30", BUCHAREST);
    expect(overlap.ok && overlap.date.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("fus necunoscut → eroare de programare, nu un moment ghicit", () => {
    expect(() => parseLocalDateTime("23.10.2026", "10:00", "Marte/Olympus")).toThrow(RangeError);
  });
});

describe("afișarea orei în ora magazinului", () => {
  const moment = new Date("2026-10-23T11:30:00Z");

  it("dată, oră și amândouă", () => {
    expect(formatLocalDate(moment, BUCHAREST)).toBe("23.10.2026");
    expect(formatLocalTime(moment, BUCHAREST)).toBe("14:30");
    expect(formatLocalDateTime(moment, BUCHAREST)).toBe("23.10.2026, 14:30");
  });

  it("zerouri în față la zi, lună, oră și minute", () => {
    const early = new Date("2027-01-05T03:04:00Z");
    expect(formatLocalDate(early, BUCHAREST)).toBe("05.01.2027");
    expect(formatLocalTime(early, BUCHAREST)).toBe("05:04");
  });

  it("ziua locală, nu cea UTC", () => {
    // 23:30 UTC vara = 02:30 a doua zi la București
    expect(formatLocalDateTime(new Date("2026-07-01T23:30:00Z"), BUCHAREST)).toBe(
      "02.07.2026, 02:30",
    );
  });

  it("dus-întors: ce se afișează se poate introduce înapoi", () => {
    const parsed = parseLocalDateTime(
      formatLocalDate(moment, BUCHAREST),
      formatLocalTime(moment, BUCHAREST),
      BUCHAREST,
    );
    expect(parsed.ok && parsed.date.toISOString()).toBe(moment.toISOString());
  });
});
