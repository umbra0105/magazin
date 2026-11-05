import { describe, expect, it, vi } from "vitest";
import { resolveWarehouseChoice, type SelectableWarehouse } from "./warehouse-selection";

/**
 * Alegerea depozitului afișat în pagina Stoc (Faza 5, 13d). Regula: selectorul, transferul și `?depozit=` există DOAR cu
 * steagul `multiWarehouse` pornit și cel puțin două depozite active; în rest pagina rămâne exact ca până acum (depozitul
 * implicit, fără selector), iar cu steagul oprit nici nu se citesc depozitele.
 */

const MAIN: SelectableWarehouse = {
  id: "w-main",
  code: "depozit_principal",
  name: "Depozit principal",
  isDefault: true,
};
const NORD: SelectableWarehouse = {
  id: "w-nord",
  code: "magazin_nord",
  name: "Magazin Nord",
  isDefault: false,
};
const SUD: SelectableWarehouse = {
  id: "w-sud",
  code: "magazin_sud",
  name: "Magazin Sud",
  isDefault: false,
};

const loader = (rows: SelectableWarehouse[]) => vi.fn(async () => rows);

describe("steagul oprit: nimic nu se schimbă", () => {
  it("nu citește depozitele, nu arată selectorul și ignoră ?depozit=", async () => {
    const load = loader([MAIN, NORD]);
    const choice = await resolveWarehouseChoice({
      enabled: false,
      requested: NORD.code,
      loadActive: load,
    });
    expect(load).not.toHaveBeenCalled();
    expect(choice).toEqual({
      visible: false,
      selected: null,
      urlCode: null,
      options: [],
      destinations: [],
    });
  });

  it("un cod care există ca depozit nu devine alegere nici cu valoare multiplă", async () => {
    const load = loader([MAIN, NORD]);
    const choice = await resolveWarehouseChoice({
      enabled: false,
      requested: [NORD.code, SUD.code],
      loadActive: load,
    });
    expect(choice.selected).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("steagul pornit, dar un singur depozit activ: tot fără selector", () => {
  it("un singur depozit activ → fără selector, ?depozit= ignorat", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: NORD.code,
      loadActive: loader([MAIN]),
    });
    expect(choice).toEqual({
      visible: false,
      selected: null,
      urlCode: null,
      options: [],
      destinations: [],
    });
  });

  it("nicio listă (bază fără depozite active) → fără selector", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: undefined,
      loadActive: loader([]),
    });
    expect(choice.visible).toBe(false);
    expect(choice.selected).toBeNull();
  });
});

describe("steagul pornit și cel puțin două depozite active", () => {
  const all = [MAIN, NORD, SUD];

  it("fără ?depozit= → depozitul implicit, fără cod în adresă", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: undefined,
      loadActive: loader(all),
    });
    expect(choice.visible).toBe(true);
    expect(choice.selected).toEqual(MAIN);
    expect(choice.urlCode).toBeNull();
    expect(choice.options).toEqual(all);
  });

  it("un cod valid alege acel depozit și intră în adresă", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: SUD.code,
      loadActive: loader(all),
    });
    expect(choice.selected).toEqual(SUD);
    expect(choice.urlCode).toBe(SUD.code);
  });

  it("codul depozitului implicit alege implicitul și NU intră în adresă (adresa canonică e cea fără cod)", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: MAIN.code,
      loadActive: loader(all),
    });
    expect(choice.selected).toEqual(MAIN);
    expect(choice.urlCode).toBeNull();
  });

  it("un cod necunoscut sau gol revine la depozitul implicit", async () => {
    for (const requested of ["nu_exista", "", "   ", "MAGAZIN_NORD", "magazin_nord "]) {
      const choice = await resolveWarehouseChoice({
        enabled: true,
        requested,
        loadActive: loader(all),
      });
      expect(choice.selected, JSON.stringify(requested)).toEqual(MAIN);
      expect(choice.urlCode, JSON.stringify(requested)).toBeNull();
    }
  });

  it("un depozit dezactivat nu e în listă, deci codul lui se ignoră", async () => {
    // lista primită conține doar depozitele ACTIVE (serviciul `listActive`)
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: "magazin_vechi",
      loadActive: loader(all),
    });
    expect(choice.selected).toEqual(MAIN);
  });

  it("la mai multe valori ale parametrului se ia prima", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: [NORD.code, SUD.code],
      loadActive: loader(all),
    });
    expect(choice.selected).toEqual(NORD);
    const reversed = await resolveWarehouseChoice({
      enabled: true,
      requested: ["nu_exista", SUD.code],
      loadActive: loader(all),
    });
    expect(reversed.selected).toEqual(MAIN);
  });

  it("opțiunile păstrează ordinea primită; depozitul implicit e ales și când nu e primul în listă", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: undefined,
      loadActive: loader([NORD, MAIN, SUD]),
    });
    expect(choice.options.map((o) => o.code)).toEqual([NORD.code, MAIN.code, SUD.code]);
    expect(choice.selected).toEqual(MAIN);
  });

  it("fără depozit marcat implicit în listă, alege primul (nu aruncă)", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: undefined,
      loadActive: loader([NORD, SUD]),
    });
    expect(choice.visible).toBe(true);
    expect(choice.selected).toEqual(NORD);
    expect(choice.urlCode).toBe(NORD.code);
  });

  it("destinațiile unui transfer sunt toate depozitele active în afară de cel afișat", async () => {
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: NORD.code,
      loadActive: loader(all),
    });
    expect(choice.destinations.map((o) => o.code)).toEqual([MAIN.code, SUD.code]);
    const hidden = await resolveWarehouseChoice({
      enabled: false,
      requested: NORD.code,
      loadActive: loader(all),
    });
    expect(hidden.destinations).toEqual([]);
  });
});

describe("steagul oprit între verificare și citire", () => {
  it("FEATURE_DISABLED la citirea depozitelor = ca și cum steagul ar fi oprit", async () => {
    const disabled = Object.assign(new Error("oprit"), { code: "FEATURE_DISABLED" });
    const choice = await resolveWarehouseChoice({
      enabled: true,
      requested: NORD.code,
      loadActive: async () => {
        throw disabled;
      },
    });
    expect(choice).toEqual({
      visible: false,
      selected: null,
      urlCode: null,
      options: [],
      destinations: [],
    });
  });

  it("orice altă eroare se propagă (nu se ascunde o bază căzută)", async () => {
    await expect(
      resolveWarehouseChoice({
        enabled: true,
        requested: undefined,
        loadActive: async () => {
          throw new Error("baza nu răspunde");
        },
      }),
    ).rejects.toThrow("baza nu răspunde");
  });
});
