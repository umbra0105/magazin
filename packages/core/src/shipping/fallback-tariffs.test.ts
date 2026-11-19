import { describe, expect, it } from "vitest";
import { fallbackOffers, type FallbackZone } from "./fallback-tariffs";

const zone = (over: Partial<FallbackZone> = {}): FallbackZone => ({
  id: "z1",
  name: "Zona 1",
  isActive: true,
  countyCodes: [10, 23],
  methods: [
    {
      id: "m1",
      code: "curier-zona-1",
      name: "Curier",
      carrier: "Curier propriu",
      type: "weight",
      priceMinor: 2000,
      rules: { includedKg: 5, perExtraKgMinor: 300 },
      freeAboveMinor: null,
      codFeeMinor: 500,
      estimatedDays: 3,
      isActive: true,
    },
  ],
  ...over,
});

const input = (over: Partial<Parameters<typeof fallbackOffers>[0]> = {}) => ({
  zones: [zone()],
  countyCode: 10,
  chargeableGrams: 3000,
  subtotalMinor: 10_000,
  ...over,
});

describe("tarife pe zonă (rezerva când furnizorul nu răspunde)", () => {
  it("județul din zonă primește oferta, cu prețul de bază sub greutatea inclusă", () => {
    const [offer, ...rest] = fallbackOffers(input());
    expect(rest).toEqual([]);
    expect(offer).toMatchObject({
      code: "fallback:curier-zona-1",
      kind: "courier",
      carrier: "Curier propriu",
      priceMinor: 2000,
      codFeeMinor: 500,
      estimatedDays: 3,
      source: "fallback",
      demo: false,
    });
  });

  it("peste greutatea inclusă: se adaugă tariful pe fiecare kg ÎNCEPUT în plus", () => {
    // 5 kg incluși; 7.001 g → 3 kg începuți în plus → 2000 + 3×300
    expect(fallbackOffers(input({ chargeableGrams: 7001 }))[0]?.priceMinor).toBe(2900);
    // exact 5 kg: fără adaos; 5.001 g: 1 kg în plus
    expect(fallbackOffers(input({ chargeableGrams: 5000 }))[0]?.priceMinor).toBe(2000);
    expect(fallbackOffers(input({ chargeableGrams: 5001 }))[0]?.priceMinor).toBe(2300);
  });

  it("metoda cu preț fix ignoră greutatea", () => {
    const flat = zone({
      methods: [
        { ...(zone().methods[0] as FallbackZone["methods"][number]), type: "flat", rules: {} },
      ],
    });
    expect(fallbackOffers(input({ zones: [flat], chargeableGrams: 90_000 }))[0]?.priceMinor).toBe(
      2000,
    );
  });

  it("un județ din afara zonei nu primește nimic; zona inactivă și metoda inactivă sunt ignorate", () => {
    expect(fallbackOffers(input({ countyCode: 99 }))).toEqual([]);
    expect(fallbackOffers(input({ zones: [zone({ isActive: false })] }))).toEqual([]);
    const off = zone({
      methods: [{ ...(zone().methods[0] as FallbackZone["methods"][number]), isActive: false }],
    });
    expect(fallbackOffers(input({ zones: [off] }))).toEqual([]);
  });

  it("pragul propriu al metodei: gratuit la suma atinsă, exact la prag, nu sub", () => {
    const withThreshold = zone({
      methods: [
        { ...(zone().methods[0] as FallbackZone["methods"][number]), freeAboveMinor: 20_000 },
      ],
    });
    expect(
      fallbackOffers(input({ zones: [withThreshold], subtotalMinor: 20_000 }))[0],
    ).toMatchObject({
      priceMinor: 0,
      freeShipping: true,
    });
    expect(
      fallbackOffers(input({ zones: [withThreshold], subtotalMinor: 19_999 }))[0]?.priceMinor,
    ).toBe(2000);
  });

  it("mai multe metode într-o zonă: toate apar, în ordinea dată; mai multe zone: doar cele ale județului", () => {
    const two = zone({
      methods: [
        { ...(zone().methods[0] as FallbackZone["methods"][number]), id: "a", code: "a" },
        { ...(zone().methods[0] as FallbackZone["methods"][number]), id: "b", code: "b" },
      ],
    });
    const other = zone({ id: "z2", countyCodes: [40] });
    expect(fallbackOffers(input({ zones: [two, other] })).map((o) => o.code)).toEqual([
      "fallback:a",
      "fallback:b",
    ]);
  });

  it("regulile greșite din bază nu strică calculul: lipsa lui includedKg înseamnă 0 kg incluși", () => {
    const broken = zone({
      methods: [{ ...(zone().methods[0] as FallbackZone["methods"][number]), rules: {} }],
    });
    expect(fallbackOffers(input({ zones: [broken], chargeableGrams: 2000 }))[0]?.priceMinor).toBe(
      2000,
    );
  });
});
