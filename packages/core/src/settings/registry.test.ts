import { describe, expect, it } from "vitest";
import { getSettingSchema, listSettingKeys, settingGroups } from "./registry";

describe("registrul de setări", () => {
  it("fiecare cheie are o valoare implicită validă (parse(undefined) reușește)", () => {
    const keys = listSettingKeys();
    expect(keys.length).toBeGreaterThan(25);
    for (const { key } of keys) {
      const schema = getSettingSchema(key);
      expect(schema, key).toBeDefined();
      expect(schema?.safeParse(undefined).success, key).toBe(true);
    }
  });

  it("cheile sunt unice și au forma grup.nume", () => {
    const keys = listSettingKeys().map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const { key, group } of listSettingKeys()) {
      expect(key.startsWith(`${group}.`), key).toBe(true);
      expect(key.split(".")).toHaveLength(2);
    }
  });

  it("nu recunoaște chei inexistente sau prototipuri", () => {
    for (const key of [
      "nu.exista",
      "tax.nu_exista",
      "tax",
      "",
      "__proto__.x",
      "constructor.name",
    ]) {
      expect(getSettingSchema(key), key).toBeUndefined();
    }
  });

  it("valorile implicite fiscale și regionale ale pachetului", () => {
    expect(settingGroups.tax.standardRate.parse(undefined)).toBe(21);
    expect(settingGroups.regional.allowedCountries.parse(undefined)).toEqual(["RO"]);
    expect(settingGroups.regional.currency.parse(undefined)).toBe("RON");
    expect(settingGroups.regional.locale.parse(undefined)).toBe("ro-RO");
    expect(settingGroups.regional.timezone.parse(undefined)).toBe("Europe/Bucharest");
    expect(settingGroups.inventory.manageStock.parse(undefined)).toBe(true);
    expect(settingGroups.inventory.reservationMinutes.parse(undefined)).toBe(15);
    expect(settingGroups.monitoring.sentryDsn.parse(undefined)).toBe("");
  });

  describe("validări", () => {
    const ok = (key: string, value: unknown) => getSettingSchema(key)?.safeParse(value).success;

    it("TVA: 0, zecimale și 100 sunt valide; negativ, peste 100, text și NaN nu", () => {
      for (const value of [0, 5.5, 19, 21, 100])
        expect(ok("tax.standardRate", value), String(value)).toBe(true);
      for (const value of [-1, 100.01, "21", Number.NaN, null]) {
        expect(ok("tax.standardRate", value), String(value)).toBe(false);
      }
    });

    it("țări: coduri de 2 litere, cel puțin una; monedă de 3 litere", () => {
      expect(ok("regional.allowedCountries", ["RO", "HU"])).toBe(true);
      expect(ok("regional.allowedCountries", [])).toBe(false);
      expect(ok("regional.allowedCountries", ["ROU"])).toBe(false);
      expect(ok("regional.currency", "EUR")).toBe(true);
      expect(ok("regional.currency", "LEI")).toBe(true);
      expect(ok("regional.currency", "RO")).toBe(false);
    });

    it("rezervare stoc: minute întregi ≥ 1", () => {
      expect(ok("inventory.reservationMinutes", 30)).toBe(true);
      for (const value of [0, -5, 1.5, "15"]) {
        expect(ok("inventory.reservationMinutes", value), String(value)).toBe(false);
      }
    });

    it("DSN Sentry: gol sau URL http(s); nimic altceva", () => {
      for (const value of [
        "",
        "https://key@o1.ingest.sentry.io/1",
        "http://abc@localhost:9999/1",
      ]) {
        expect(ok("monitoring.sentryDsn", value), value).toBe(true);
      }
      for (const value of [
        "javascript:alert(1)",
        "ftp://x",
        "nu e url",
        "https://a b",
        "data:text/html,x",
      ]) {
        expect(ok("monitoring.sentryDsn", value), value).toBe(false);
      }
    });

    it("adresa firmei cere toate câmpurile și o țară de 2 litere", () => {
      const address = {
        street: "Str. X 1",
        city: "București",
        county: "B",
        postalCode: "010101",
        country: "RO",
      };
      expect(ok("company.address", address)).toBe(true);
      expect(ok("company.address", { ...address, country: "ROM" })).toBe(false);
      expect(ok("company.address", { street: "x" })).toBe(false);
    });
  });
});
