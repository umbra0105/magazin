import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@ecom/shared";
import {
  SETTINGS_CACHE_KEY,
  SettingsService,
  type SettingsCache,
  type SettingsStore,
} from "./settings-service";

function fakes() {
  const rows = new Map<string, { group: string; value: unknown }>();
  const cacheData = new Map<string, string>();
  const calls = { loadAll: 0 };
  const store: SettingsStore = {
    async loadAll() {
      calls.loadAll++;
      return [...rows].map(([key, r]) => ({ key, value: r.value }));
    },
    async upsert({ key, group, value }) {
      rows.set(key, { group, value });
    },
  };
  const cache: SettingsCache = {
    async get(key) {
      return cacheData.get(key) ?? null;
    },
    async set(key, value) {
      cacheData.set(key, value);
      return "OK";
    },
    async del(key) {
      return cacheData.delete(key) ? 1 : 0;
    },
  };
  return { rows, cacheData, calls, store, cache };
}

describe("SettingsService", () => {
  let f: ReturnType<typeof fakes>;
  let service: SettingsService;

  beforeEach(() => {
    f = fakes();
    service = new SettingsService(f.store, f.cache);
  });

  it("dă valorile implicite când baza e goală", async () => {
    expect(await service.get("tax.standardRate")).toBe(21);
    expect(await service.get("regional.allowedCountries")).toEqual(["RO"]);
    expect(await service.get("general.storeName")).toBe("Magazin online");
    expect((await service.getGroup("inventory")).reservationMinutes).toBe(15);
  });

  it("citește din cache la a doua citire (o singură interogare în DB)", async () => {
    await service.get("tax.standardRate");
    await service.get("general.storeName");
    await service.getGroup("company");
    expect(f.calls.loadAll).toBe(1);
    expect(f.cacheData.has(SETTINGS_CACHE_KEY)).toBe(true);
  });

  it("invalidează cache-ul la scriere și citește valoarea nouă", async () => {
    expect(await service.get("general.storeName")).toBe("Magazin online");
    await service.set("general.storeName", "Piscine Test");
    expect(f.cacheData.has(SETTINGS_CACHE_KEY)).toBe(false);
    expect(await service.get("general.storeName")).toBe("Piscine Test");
    expect(f.calls.loadAll).toBe(2);
  });

  it("respinge valori invalide și chei necunoscute, fără să scrie", async () => {
    await expect(service.set("tax.standardRate", 150)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.set("tax.standardRate", "21")).rejects.toBeInstanceOf(ValidationError);
    await expect(service.set("regional.allowedCountries", [])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.set("nu.exista" as unknown as "tax.standardRate", 1),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(f.rows.size).toBe(0);
  });

  it("aruncă (nu folosește default) dacă valoarea stocată e coruptă", async () => {
    f.rows.set("tax.standardRate", { group: "tax", value: "abc" });
    await expect(service.get("tax.standardRate")).rejects.toBeInstanceOf(ValidationError);
  });

  it("cade pe DB când Redis e picat", async () => {
    const broken: SettingsCache = {
      get: () => Promise.reject(new Error("redis picat")),
      set: () => Promise.reject(new Error("redis picat")),
      del: () => Promise.reject(new Error("redis picat")),
    };
    const s = new SettingsService(f.store, broken);
    await s.set("tax.standardRate", 19);
    expect(await s.get("tax.standardRate")).toBe(19);
  });

  it("getCompanyInfo adună numele magazinului și datele firmei", async () => {
    await service.set("general.storeName", "Piscine Test");
    await service.set("company.legalName", "Piscine Test SRL");
    await service.set("company.vatId", "RO123456");
    const info = await service.getCompanyInfo();
    expect(info.storeName).toBe("Piscine Test");
    expect(info.legalName).toBe("Piscine Test SRL");
    expect(info.vatId).toBe("RO123456");
    expect(info.address.country).toBe("RO");
  });
});
