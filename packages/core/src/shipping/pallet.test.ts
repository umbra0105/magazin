import { describe, expect, it } from "vitest";
import { quantityFromTicks } from "@ecom/shared";
import { buildParcel } from "./parcels";
import {
  PALLET_OFFER_CODE,
  decidePalletTransport,
  palletCount,
  palletOffer,
  type PalletSettings,
} from "./pallet";
import type { Parcel, RateOffer, ShippingClass } from "./types";

const q = (units: number) => quantityFromTicks(BigInt(Math.round(units * 10_000)));

/** Valorile utilizatorului (2026-11-22): 350 lei per palet, prag 400 lei, 600 kg și 1,2 m³ per palet. */
const SETTINGS: PalletSettings = {
  priceMinor: 35_000,
  switchThresholdMinor: 40_000,
  maxWeightGrams: 600_000,
  maxVolumeCm3: 1_200_000,
};

const parcel = (over: Partial<Parameters<typeof buildParcel>[0]> = {}): Parcel =>
  buildParcel({
    variantId: "v1",
    sku: "SKU-1",
    shippingClass: "standard" as ShippingClass,
    quantity: q(1),
    weightGrams: 1000,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
    ...over,
  });

const courier = (priceMinor: number, over: Partial<RateOffer> = {}): RateOffer => ({
  code: "demo:courier",
  kind: "courier",
  carrier: "Curier",
  service: "Standard",
  priceMinor,
  estimatedDays: 2,
  codFeeMinor: 500,
  source: "provider",
  demo: false,
  freeShipping: false,
  ...over,
});
const easybox = (priceMinor: number): RateOffer =>
  courier(priceMinor, { code: "demo:easybox", kind: "easybox" });

describe("volumul liniei (cm³) și bucățile întregi, în colet", () => {
  it("30×30×20 cm × 10 cutii = 180.000 cm³", () => {
    const p = parcel({ lengthMm: 300, widthMm: 300, heightMm: 200, quantity: q(10) });
    expect(p.volumeCm3).toBe(180_000);
    expect(p.wholeUnits).toBe(10);
  });
  it("cantitatea zecimală se rotunjește în sus: 2,03 → 3 bucăți întregi; volumul în sus la cm³", () => {
    const p = parcel({ lengthMm: 101, widthMm: 100, heightMm: 100, quantity: q(2.03) });
    expect(p.wholeUnits).toBe(3);
    // 1.010.000 mm³ × 2,03 = 2.050.300 mm³ = 2050,3 cm³ → 2051
    expect(p.volumeCm3).toBe(2051);
  });
  it("fără dimensiuni: volum 0 și linia e «incompletă»", () => {
    const p = parcel({ lengthMm: null });
    expect(p.volumeCm3).toBe(0);
    expect(p.incomplete).toBe(true);
  });
});

describe("numărul de paleți: ⌈max(greutate ÷ capacitate, volum ÷ capacitate)⌉, minim 1", () => {
  it("exemplul utilizatorului: 10 cutii 30×30×20 cm, 20 kg fiecare = 200 kg, 180.000 cm³ → 1 palet", () => {
    const p = parcel({
      weightGrams: 20_000,
      lengthMm: 300,
      widthMm: 300,
      heightMm: 200,
      quantity: q(10),
    });
    expect(palletCount([p], SETTINGS)).toBe(1);
  });
  it("greutatea decide: 1.300 kg → 3 paleți (⌈1300/600⌉)", () => {
    expect(palletCount([parcel({ weightGrams: 1_300_000 })], SETTINGS)).toBe(3);
  });
  it("exact pe capacitate: 600 kg → 1 palet; 600,001 kg → 2 paleți", () => {
    expect(palletCount([parcel({ weightGrams: 600_000 })], SETTINGS)).toBe(1);
    expect(palletCount([parcel({ weightGrams: 600_001 })], SETTINGS)).toBe(2);
  });
  it("volumul decide: 2.500.000 cm³ ușor → 3 paleți (⌈2,5/1,2⌉)", () => {
    const p = parcel({
      weightGrams: 10_000,
      lengthMm: 1000,
      widthMm: 1000,
      heightMm: 2500,
    }); // 100×100×250 cm = 2.500.000 cm³
    expect(p.volumeCm3).toBe(2_500_000);
    expect(palletCount([p], SETTINGS)).toBe(3);
  });
  it("produse diferite se amestecă pe același palet: se însumează greutatea și volumul liniilor", () => {
    const a = parcel({ variantId: "a", weightGrams: 350_000 });
    const b = parcel({ variantId: "b", weightGrams: 200_000 });
    expect(palletCount([a, b], SETTINGS)).toBe(1); // 550 kg
    const c = parcel({ variantId: "c", weightGrams: 100_000 });
    expect(palletCount([a, b, c], SETTINGS)).toBe(2); // 650 kg
  });
  it("minim 1 chiar și pentru un coș aproape fără greutate", () => {
    expect(palletCount([parcel({ weightGrams: 1 })], SETTINGS)).toBe(1);
    expect(palletCount([], SETTINGS)).toBe(1);
  });
  it("greutatea unei linii e greutate pe unitate × cantitate, exact (25 kg × 30 = 750 kg → 2 paleți)", () => {
    expect(palletCount([parcel({ weightGrams: 25_000, quantity: q(30) })], SETTINGS)).toBe(2);
  });
  it("produs `pallet` fără date: 1 palet pe bucată (prudent), 3 bucăți → 3 paleți", () => {
    const p = parcel({
      shippingClass: "pallet",
      weightGrams: null,
      lengthMm: null,
      quantity: q(3),
    });
    expect(p.incomplete).toBe(true);
    expect(palletCount([p], SETTINGS)).toBe(3);
  });
  it("produs `pallet` fără date + linii cu date: paleții prudenți se adună peste cei estimați", () => {
    const unknown = parcel({
      variantId: "u",
      shippingClass: "pallet",
      weightGrams: null,
      quantity: q(2),
    });
    const known = parcel({ variantId: "k", weightGrams: 500_000 });
    expect(palletCount([unknown, known], SETTINGS)).toBe(3);
  });
  it("produs standard fără date NU adaugă paleți (doar e marcat incomplet)", () => {
    const unknown = parcel({ variantId: "u", weightGrams: null, quantity: q(5) });
    const known = parcel({ variantId: "k", weightGrams: 500_000 });
    expect(palletCount([unknown, known], SETTINGS)).toBe(1);
  });
  it("capacitate 0 sau negativă în setări nu produce împărțire la zero: se tratează ca 1", () => {
    expect(palletCount([parcel({ weightGrams: 5 })], { ...SETTINGS, maxWeightGrams: 0 })).toBe(5);
  });
});

describe("oferta paletizată: preț fix per palet, cu TVA inclus", () => {
  it("1 palet = 350,00 lei; 3 paleți = 1.050,00 lei", () => {
    expect(palletOffer(1, SETTINGS, 0).priceMinor).toBe(35_000);
    expect(palletOffer(3, SETTINGS, 0).priceMinor).toBe(105_000);
  });
  it("cod stabil, tip «pallet», fără scutire, nu e DEMO, nu vine de la furnizor", () => {
    const offer = palletOffer(2, SETTINGS, 700);
    expect(offer).toMatchObject({
      code: PALLET_OFFER_CODE,
      kind: "pallet",
      freeShipping: false,
      demo: false,
      source: "pallet",
      codFeeMinor: 700,
      pallets: 2,
    });
  });
});

describe("când se oferă paletizatul", () => {
  const light = [parcel({ weightGrams: 5_000 })];
  const heavyClass = [parcel({ shippingClass: "pallet", weightGrams: 70_000 })];

  it("(a) o linie `pallet` în coș: DOAR paletizat, fără curier și fără easybox", () => {
    const decision = decidePalletTransport({
      parcels: [...light, ...heavyClass],
      offers: [courier(60_000), easybox(2_000)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("pallet_only");
    expect(decision.offers.map((o) => o.kind)).toEqual(["pallet"]);
  });

  it("(b) curierul depășește 400 lei și paletul e mai ieftin: curierul și easybox dispar, rămâne paletul", () => {
    // 10 cutii de pietre de saună: la curier ~650 lei, 1 palet = 350 lei
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(65_000), easybox(60_000)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("switched");
    expect(decision.offers).toHaveLength(1);
    expect(decision.offers[0]).toMatchObject({ kind: "pallet", priceMinor: 35_000 });
  });

  it("(b) paletul egal cu curierul: se trece pe palet (MAI MIC SAU EGAL)", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(40_001)],
      settings: { ...SETTINGS, priceMinor: 40_001 },
      providerRefused: false,
    });
    expect(decision.mode).toBe("switched");
  });

  it("(b) paletul ar costa MAI MULT decât curierul: curierul rămâne (3 paleți = 1.050 lei > 900 lei)", () => {
    const decision = decidePalletTransport({
      parcels: [parcel({ weightGrams: 1_300_000 })],
      offers: [courier(90_000)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("courier");
    expect(decision.offers.map((o) => o.kind)).toEqual(["courier"]);
  });

  it("(b) curierul sub prag (exact 400 lei NU depășește): rămâne curierul, fără ofertă paletizată", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(40_000)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("courier");
    expect(decision.offers).toHaveLength(1);
  });

  it("(b) 40.001 de bani depășește pragul: comparația e strictă", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(40_001)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("switched");
  });

  it("(b) cu mai multe oferte de curier, comparația se face cu cea mai ieftină", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(38_000, { code: "a" }), courier(90_000, { code: "b" })],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("courier");
    expect(decision.offers).toHaveLength(2);
  });

  it("(b) pragul se compară pe prețul ÎNAINTE de transportul gratuit (oferta are deja priceMinor brut)", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(65_000)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("switched");
  });

  it("(c) furnizorul a refuzat și nu există nicio ofertă de curier: se oferă paletizatul", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [],
      settings: SETTINGS,
      providerRefused: true,
    });
    expect(decision.mode).toBe("refused");
    expect(decision.offers.map((o) => o.kind)).toEqual(["pallet"]);
  });

  it("fără oferte și fără refuz (furnizor picat): nu inventăm paletizat, lasă rezerva", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("courier");
    expect(decision.offers).toHaveLength(0);
  });

  it("taxa de ramburs a ofertei paletizate e cea a celei mai ieftine oferte de curier (aceeași taxă)", () => {
    const decision = decidePalletTransport({
      parcels: light,
      offers: [courier(65_000, { codFeeMinor: 900 })],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.offers[0]?.codFeeMinor).toBe(900);
  });

  it("`oversized` fără `pallet` nu forțează paletizatul: curierul de marfă rămâne sub prag", () => {
    const decision = decidePalletTransport({
      parcels: [parcel({ shippingClass: "oversized" })],
      offers: [courier(15_000)],
      settings: SETTINGS,
      providerRefused: false,
    });
    expect(decision.mode).toBe("courier");
  });
});
