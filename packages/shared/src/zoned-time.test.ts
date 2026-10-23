import { describe, expect, it } from "vitest";
import { isValidTimeZone, localDateTime, nextDailyRunAt, zonedLocalToUtc } from "./zoned-time";

const BUCHAREST = "Europe/Bucharest";
const iso = (text: string): Date => new Date(text);

describe("fus orar: validare", () => {
  it("recunoaște fusurile IANA și refuză restul", () => {
    expect(isValidTimeZone("Europe/Bucharest")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    for (const bad of ["", "Bucuresti", "Europe/Nowhere", "+02:00", "  "]) {
      expect(isValidTimeZone(bad), bad).toBe(false);
    }
  });
});

describe("ora locală a unui moment", () => {
  it("vară (EEST, UTC+3) și iarnă (EET, UTC+2)", () => {
    expect(localDateTime(iso("2026-07-01T09:00:00Z"), BUCHAREST)).toMatchObject({
      year: 2026,
      month: 7,
      day: 1,
      hour: 12,
      minute: 0,
      weekday: 3,
    });
    expect(localDateTime(iso("2026-01-15T22:30:15.250Z"), BUCHAREST)).toMatchObject({
      year: 2026,
      month: 1,
      day: 16,
      hour: 0,
      minute: 30,
      second: 15,
      millisecond: 250,
      weekday: 5,
    });
  });

  it("ziua locală, nu cea UTC: duminică 23:30 locală e încă duminică, iar 00:30 locală e luni", () => {
    // 2026-11-01 e duminică; la 23:30 locală (EET) e 21:30 UTC
    expect(localDateTime(iso("2026-11-01T21:30:00Z"), BUCHAREST)).toMatchObject({
      day: 1,
      hour: 23,
      weekday: 7,
    });
    expect(localDateTime(iso("2026-11-01T22:30:00Z"), BUCHAREST)).toMatchObject({
      day: 2,
      hour: 0,
      weekday: 1,
    });
  });

  it("miezul nopții se citește 0, nu 24", () => {
    expect(localDateTime(iso("2026-11-01T22:00:00Z"), BUCHAREST).hour).toBe(0);
  });

  it("fus invalid → RangeError", () => {
    expect(() => localDateTime(new Date(), "Marte/Olympus")).toThrow(RangeError);
  });
});

describe("din ora locală în moment (UTC)", () => {
  it("o oră obișnuită, în trei fusuri", () => {
    const noon = { year: 2026, month: 7, day: 1, hour: 12, minute: 0 };
    expect(zonedLocalToUtc(noon, BUCHAREST).toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(zonedLocalToUtc(noon, "UTC").toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(zonedLocalToUtc(noon, "America/New_York").toISOString()).toBe(
      "2026-07-01T16:00:00.000Z",
    );
  });

  it("ora repetată (toamna: 03:30 apare de două ori) → prima apariție", () => {
    // 2026-10-25: la 04:00 EEST ceasul se întoarce la 03:00 EET
    const local = { year: 2026, month: 10, day: 25, hour: 3, minute: 30 };
    expect(zonedLocalToUtc(local, BUCHAREST).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("ora care nu există (primăvara: 03:30 sare) → cu offsetul de dinainte, adică 04:30 locală", () => {
    // 2027-03-28: la 03:00 EET ceasul sare la 04:00 EEST
    const local = { year: 2027, month: 3, day: 28, hour: 3, minute: 30 };
    const result = zonedLocalToUtc(local, BUCHAREST);
    expect(result.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(localDateTime(result, BUCHAREST)).toMatchObject({ hour: 4, minute: 30 });
  });

  it("sfârșitul zilei (23:59:59.999) nu cade niciodată în schimbarea orei", () => {
    const local = {
      year: 2026,
      month: 10,
      day: 25,
      hour: 23,
      minute: 59,
      second: 59,
      millisecond: 999,
    };
    expect(zonedLocalToUtc(local, BUCHAREST).toISOString()).toBe("2026-10-25T21:59:59.999Z");
  });

  it("dus-întors pe 3000 de momente pseudoaleatoare în 3 fusuri (în afara orei repetate)", () => {
    let seed = 987654321;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (const zone of [BUCHAREST, "UTC", "America/New_York"]) {
      for (let i = 0; i < 1000; i++) {
        const instant = new Date(Date.UTC(2026, 0, 1) + (next() % (3 * 365 * 24 * 3600)) * 1000);
        const local = localDateTime(instant, zone);
        const back = zonedLocalToUtc(local, zone);
        // în ora repetată se întoarce prima apariție (cel mult cu o oră mai devreme); altfel exact momentul
        const diff = instant.getTime() - back.getTime();
        expect([0, 3_600_000], `${zone} ${instant.toISOString()}`).toContain(diff);
      }
    }
  });
});

describe("următoarea rulare zilnică la o oră fixă", () => {
  it("azi dacă ora nu a trecut, altfel mâine (strict după moment)", () => {
    // 03:30 la București, vară (UTC+3): 00:30 UTC
    expect(nextDailyRunAt(iso("2026-07-01T10:00:00Z"), "03:30", BUCHAREST).toISOString()).toBe(
      "2026-07-02T00:30:00.000Z",
    );
    expect(nextDailyRunAt(iso("2026-07-01T00:00:00Z"), "03:30", BUCHAREST).toISOString()).toBe(
      "2026-07-01T00:30:00.000Z",
    );
    // exact la oră → ziua următoare (strict după)
    expect(nextDailyRunAt(iso("2026-07-01T00:30:00Z"), "03:30", BUCHAREST).toISOString()).toBe(
      "2026-07-02T00:30:00.000Z",
    );
    expect(nextDailyRunAt(iso("2026-07-01T00:29:59.999Z"), "03:30", BUCHAREST).toISOString()).toBe(
      "2026-07-01T00:30:00.000Z",
    );
  });

  it("trece corect peste schimbarea orei: rămâne 03:30 locală, nu 03:30 UTC+3", () => {
    // vineri 2026-10-23 → sâmbătă 24 (EEST) → duminică 25 (ora repetată: prima 03:30) → luni 26 (EET)
    const sat = nextDailyRunAt(iso("2026-10-23T10:00:00Z"), "03:30", BUCHAREST);
    expect(sat.toISOString()).toBe("2026-10-24T00:30:00.000Z");
    const sun = nextDailyRunAt(sat, "03:30", BUCHAREST);
    expect(sun.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    const mon = nextDailyRunAt(sun, "03:30", BUCHAREST);
    expect(mon.toISOString()).toBe("2026-10-26T01:30:00.000Z");
    expect(localDateTime(mon, BUCHAREST)).toMatchObject({ day: 26, hour: 3, minute: 30 });
  });

  it("în ziua în care ora nu există, rulează la ora de după salt, fără să sară peste zi", () => {
    const sat = nextDailyRunAt(iso("2027-03-27T10:00:00Z"), "03:30", BUCHAREST);
    expect(sat.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(nextDailyRunAt(sat, "03:30", BUCHAREST).toISOString()).toBe("2027-03-29T00:30:00.000Z");
  });

  it("pe 2000 de momente: strict în viitor, în cel mult 25 de ore, la ora cerută (în afara sării)", () => {
    let seed = 24680;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (const zone of [BUCHAREST, "UTC", "America/New_York"]) {
      for (let i = 0; i < 700; i++) {
        const after = new Date(Date.UTC(2026, 0, 1) + (next() % (3 * 365 * 24 * 3600)) * 1000);
        const run = nextDailyRunAt(after, "03:30", zone);
        const wait = run.getTime() - after.getTime();
        expect(wait, `${zone} ${after.toISOString()}`).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(25 * 3_600_000);
        const local = localDateTime(run, zone);
        // în ziua cu salt de primăvară 03:30 nu există → 04:30; altfel exact 03:30
        expect([3, 4]).toContain(local.hour);
        expect(local.minute).toBe(30);
      }
    }
  });

  it("ora trebuie scrisă HH:MM, în 24 de ore", () => {
    for (const bad of ["3:30", "24:00", "03:60", "0330", "03:30:00", "", "ab:cd"]) {
      expect(() => nextDailyRunAt(new Date(), bad, BUCHAREST), bad).toThrow(RangeError);
    }
    expect(() => nextDailyRunAt(new Date(), "03:30", "Marte/Olympus")).toThrow(RangeError);
    expect(() => nextDailyRunAt(new Date("x"), "03:30", BUCHAREST)).toThrow(RangeError);
  });
});
