import { describe, expect, it } from "vitest";
import { ValidationError } from "@ecom/shared";
import { createFakeCache } from "../test-utils/fake-cache";
import {
  SETTINGS_CACHE_KEY,
  SETTINGS_CACHE_TTL_SECONDS,
  SettingsService,
  type SettingsStore,
} from "./settings-service";

function setup(initial: Record<string, unknown> = {}) {
  const rows = new Map(Object.entries(initial));
  const store: SettingsStore = {
    async loadAll() {
      return [...rows].map(([key, value]) => ({ key, value }));
    },
    async upsert({ key, value }) {
      rows.set(key, value);
    },
  };
  const fake = createFakeCache();
  return { rows, ...fake, service: new SettingsService(store, fake.cache), store };
}

describe("SettingsService: cache și grupuri", () => {
  it("scrie cache-ul cu cheia și TTL-ul de 5 minute", async () => {
    const { service, ttls } = setup();
    await service.get("tax.standardRate");
    expect(ttls.get(SETTINGS_CACHE_KEY)).toBe(SETTINGS_CACHE_TTL_SECONDS);
    expect(SETTINGS_CACHE_TTL_SECONDS).toBe(300);
  });

  it("ignoră rândurile pentru chei necunoscute (nu intră în cache)", async () => {
    const { service, data } = setup({ "tax.standardRate": 19, "veche.cheie": "x" });
    expect(await service.get("tax.standardRate")).toBe(19);
    const cached = JSON.parse(data.get(SETTINGS_CACHE_KEY) ?? "{}") as Record<string, unknown>;
    expect(cached).toEqual({ "tax.standardRate": 19 });
  });

  it("getGroup combină valorile stocate cu cele implicite", async () => {
    const { service } = setup({ "regional.currency": "EUR" });
    expect(await service.getGroup("regional")).toEqual({
      allowedCountries: ["RO"],
      defaultCountry: "RO",
      currency: "EUR",
      locale: "ro-RO",
      timezone: "Europe/Bucharest",
    });
  });

  it("getGroup aruncă ValidationError dacă o valoare stocată e coruptă", async () => {
    const { service } = setup({ "regional.allowedCountries": [] });
    await expect(service.getGroup("regional")).rejects.toBeInstanceOf(ValidationError);
  });

  it("toate grupurile se pot citi pe o bază goală", async () => {
    const { service } = setup();
    for (const group of [
      "general",
      "company",
      "regional",
      "tax",
      "inventory",
      "checkout",
      "email",
      "legal",
      "monitoring",
      "appearance",
    ] as const) {
      expect(await service.getGroup(group), group).toBeTypeOf("object");
    }
  });

  it("set întoarce valoarea validată și o scrie cu grupul corect", async () => {
    const calls: { key: string; group: string; value: unknown }[] = [];
    const { store } = setup();
    const spied = new SettingsService(
      { ...store, upsert: async (row) => void calls.push(row) },
      createFakeCache().cache,
    );
    const address = {
      street: "Str. X 1",
      city: "București",
      county: "B",
      postalCode: "010101",
      country: "RO",
    };
    expect(await spied.set("company.address", address)).toEqual(address);
    expect(calls).toEqual([{ key: "company.address", group: "company", value: address }]);
  });

  it("două instanțe (două procese) văd aceeași valoare prin același cache, iar set o invalidează", async () => {
    const { store, cache } = setup();
    const a = new SettingsService(store, cache);
    const b = new SettingsService(store, cache);
    expect(await b.get("general.storeName")).toBe("Magazin online");
    await a.set("general.storeName", "Piscine Test");
    expect(await b.get("general.storeName")).toBe("Piscine Test");
  });

  it("getCompanyInfo reflectă imediat o modificare", async () => {
    const { service } = setup();
    expect((await service.getCompanyInfo()).legalName).toBe("");
    await service.set("company.legalName", "Piscine SRL");
    expect((await service.getCompanyInfo()).legalName).toBe("Piscine SRL");
  });
});
