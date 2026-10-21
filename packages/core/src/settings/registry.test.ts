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

  describe("importul de imagini din adrese (securitate)", () => {
    const hosts = settingGroups.imageImport.allowedHosts;

    it("implicit lista de domenii permise e goală (nimic nu se descarcă)", () => {
      expect(hosts.parse(undefined)).toEqual([]);
    });

    it("numele se normalizează (litere mici, fără punct final, punycode)", () => {
      expect(hosts.parse(["PiscineShop.RO", "cdn.piscineshop.ro."])).toEqual([
        "piscineshop.ro",
        "cdn.piscineshop.ro",
      ]);
      expect(hosts.parse(["piscine.ro", "picină.ro"])[1]).toBe("xn--picin-vwa.ro");
    });

    it.each([
      ["IP v4", "10.0.0.5"],
      ["IP v6", "[::1]"],
      ["cu port", "piscineshop.ro:8443"],
      ["cu schemă", "https://piscineshop.ro"],
      ["cu cale", "piscineshop.ro/poze"],
      ["wildcard", "*.piscineshop.ro"],
      ["cu utilizator", "user@piscineshop.ro"],
      ["o singură etichetă", "localhost"],
      ["cu spații", "piscine shop.ro"],
      ["gol", ""],
    ])("refuză %s", (_name, value) => {
      expect(hosts.safeParse([value]).success).toBe(false);
    });

    it("cel mult 50 de domenii; limitele numerice au plafoane", () => {
      expect(hosts.safeParse(Array.from({ length: 51 }, (_, i) => `d${i}.ro`)).success).toBe(false);
      const g = settingGroups.imageImport;
      expect(g.maxRedirects.safeParse(4).success).toBe(false);
      expect(g.maxImagesPerProduct.safeParse(31).success).toBe(false);
      expect(g.concurrency.safeParse(11).success).toBe(false);
      expect(g.maxDownloadBytes.safeParse(51 * 1024 * 1024).success).toBe(false);
      expect(g.totalTimeoutSeconds.safeParse(121).success).toBe(false);
    });
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

    it("stoc (Faza 5): valorile implicite din decizii", () => {
      const inv = settingGroups.inventory;
      expect(inv.transferReservationWorkdays.parse(undefined)).toBe(3);
      expect(inv.defaultLeadTimeDays.parse(undefined)).toBe(14);
      expect(inv.lowStockSteps.parse(undefined)).toBe(2);
      expect(inv.snapshotSafetyWindowMinutes.parse(undefined)).toBe(30);
      expect(inv.snapshotStaleHours.parse(undefined)).toBe(24);
      expect(inv.backInStockRetentionDays.parse(undefined)).toBe(90);
    });

    it("stoc (Faza 5): întregi în limite", () => {
      const cases: Array<[string, number[], unknown[]]> = [
        ["inventory.transferReservationWorkdays", [1, 3, 30], [0, 31, 2.5, "3"]],
        ["inventory.defaultLeadTimeDays", [0, 14, 365], [-1, 366, 1.5, "14"]],
        ["inventory.lowStockSteps", [0, 2, 1000], [-1, 1001, 0.5, "2"]],
        ["inventory.snapshotSafetyWindowMinutes", [0, 30, 1440], [-1, 1441, 1.5]],
        ["inventory.snapshotStaleHours", [1, 24, 720], [0, 721, 1.5]],
        ["inventory.backInStockRetentionDays", [1, 90, 365], [0, 366, 1.5]],
      ];
      for (const [key, good, bad] of cases) {
        for (const value of good) expect(ok(key, value), `${key}=${value}`).toBe(true);
        for (const value of bad) expect(ok(key, value), `${key}=${String(value)}`).toBe(false);
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
