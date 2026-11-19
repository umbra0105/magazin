import { describe, expect, it } from "vitest";
import { quantityFromTicks } from "@ecom/shared";
import { buildParcel, chargeableGramsTotal, volumetricGrams } from "./parcels";

const q = (units: number) => quantityFromTicks(BigInt(Math.round(units * 10_000)));
const line = (over: Partial<Parameters<typeof buildParcel>[0]> = {}) => ({
  variantId: "v1",
  sku: "SKU-1",
  shippingClass: "standard" as const,
  quantity: q(1),
  weightGrams: 1000,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 100,
  ...over,
});

describe("greutatea volumetrică: (L×l×h)/5000, cu dimensiunile în cm", () => {
  it("120×50×60 cm = 72 kg volumetric (exemplul din docs/15)", () => {
    expect(volumetricGrams(1200, 500, 600, q(1))).toBe(72_000);
  });
  it("10×10×10 cm = 200 g", () => {
    expect(volumetricGrams(100, 100, 100, q(1))).toBe(200);
  });
  it("se înmulțește cu cantitatea (3 bucăți = 600 g)", () => {
    expect(volumetricGrams(100, 100, 100, q(3))).toBe(600);
  });
  it("se rotunjește în sus la gram (fracțiune de gram nu dispare)", () => {
    expect(volumetricGrams(101, 100, 100, q(1))).toBe(202); // 1.010.000 mm³ / 5000 = 202
    expect(volumetricGrams(101, 101, 100, q(1))).toBe(205); // 1.020.100 / 5000 = 204,02 → 205
  });
});

describe("colet pe linie: tarifare pe cea mai mare dintre greutatea reală și cea volumetrică", () => {
  it("o pompă de 60 kg, 120×50×60 cm: volumetric 72 kg > real 60 kg → 72 kg", () => {
    const parcel = buildParcel(
      line({ weightGrams: 60_000, lengthMm: 1200, widthMm: 500, heightMm: 600 }),
    );
    expect(parcel).toMatchObject({
      realGrams: 60_000,
      volumetricGrams: 72_000,
      chargeableGrams: 72_000,
      incomplete: false,
    });
  });

  it("un produs dens: greutatea reală câștigă (10 kg într-o cutie mică)", () => {
    const parcel = buildParcel(line({ weightGrams: 10_000 }));
    expect(parcel.realGrams).toBe(10_000);
    expect(parcel.volumetricGrams).toBe(200);
    expect(parcel.chargeableGrams).toBe(10_000);
  });

  it("greutatea reală = greutate pe unitate × cantitate, exact, în sus la gram (2,03 mp × 3 g)", () => {
    expect(buildParcel(line({ quantity: q(2.03), weightGrams: 3 })).realGrams).toBe(7); // 6,09 → 7
    expect(buildParcel(line({ quantity: q(41.25), weightGrams: 2000 })).realGrams).toBe(82_500);
  });

  it("comparația se face pe LINIE, nu pe produs: 3 bucăți ușoare dar voluminoase", () => {
    const parcel = buildParcel(
      line({ quantity: q(3), weightGrams: 500, lengthMm: 400, widthMm: 400, heightMm: 400 }),
    );
    expect(parcel.realGrams).toBe(1500);
    expect(parcel.volumetricGrams).toBe(3 * 12_800);
    expect(parcel.chargeableGrams).toBe(38_400);
  });

  it("lipsa greutății sau a unei dimensiuni marchează coletul «incomplet», fără să arunce", () => {
    expect(buildParcel(line({ weightGrams: null }))).toMatchObject({
      realGrams: 0,
      incomplete: true,
    });
    expect(buildParcel(line({ heightMm: null }))).toMatchObject({
      volumetricGrams: 0,
      chargeableGrams: 1000,
      incomplete: true,
    });
  });

  it("păstrează clasa de transport", () => {
    expect(buildParcel(line({ shippingClass: "pallet" })).shippingClass).toBe("pallet");
  });
});

describe("chargeableGramsTotal", () => {
  it("suma greutăților tarifabile ale liniilor", () => {
    const parcels = [
      buildParcel(line({ weightGrams: 10_000 })),
      buildParcel(
        line({ variantId: "v2", weightGrams: 60_000, lengthMm: 1200, widthMm: 500, heightMm: 600 }),
      ),
    ];
    expect(chargeableGramsTotal(parcels)).toBe(10_000 + 72_000);
  });
  it("fără colete: 0", () => {
    expect(chargeableGramsTotal([])).toBe(0);
  });
});
