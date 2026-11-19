import { describe, expect, it } from "vitest";
import type { CheckoutPreview, RateOffer } from "@ecom/core";
import { toCheckoutPreviewDto } from "./checkout-dto";

const FORMAT = { currency: "RON", locale: "ro-RO" };
const LIMITS = { codMaxIndividualMinor: 1_000_000, codMaxCompanyMinor: 500_000 };

const offer = (over: Partial<RateOffer> = {}): RateOffer => ({
  code: "demo:courier",
  kind: "courier",
  carrier: "Curier DEMO",
  service: "Standard",
  priceMinor: 2_500,
  estimatedDays: 2,
  codFeeMinor: 0,
  source: "provider",
  demo: true,
  freeShipping: false,
  ...over,
});

const PICKUP: RateOffer = offer({
  code: "pickup",
  kind: "pickup",
  carrier: "Ridicare personală",
  service: "de la sediu",
  priceMinor: 0,
  estimatedDays: 0,
  source: "pickup",
  demo: false,
  pickupAddress: {
    street: "Strada Exemplu 1",
    city: "Alba Iulia",
    county: "Alba",
    postalCode: "510000",
    country: "RO",
    text: "Strada Exemplu 1, Alba Iulia, Alba, 510000, RO",
  },
});

/** Doar câmpurile pe care DTO-ul le citește; restul previzualizării nu intră în joc. */
const preview = (offers: RateOffer[], selected: RateOffer | null): CheckoutPreview =>
  ({
    view: { leadTime: null },
    blocked: null,
    destination: { countyName: "Cluj", localityName: "Cluj-Napoca" },
    shipping: { offers, fallbackUsed: false, incomplete: false },
    selectedOffer: selected,
    methods: null,
    totals: null,
    taxRateBps: 2100,
  }) as unknown as CheckoutPreview;

describe("oferta de ridicare în previzualizarea checkout-ului", () => {
  const dto = toCheckoutPreviewDto(preview([offer(), PICKUP], PICKUP), FORMAT, LIMITS, {
    isCompany: false,
  });
  const pickup = dto.offers.find((o) => o.kind === "pickup");

  it("arată «Adresa de ridicare: <adresa magazinului>»", () => {
    expect(pickup?.addressLine).toBe(
      "Adresa de ridicare: Strada Exemplu 1, Alba Iulia, Alba, 510000, RO",
    );
  });

  it("rămâne fără cost de transport", () => {
    expect(pickup).toMatchObject({ priceText: "Gratuit", free: true });
  });

  it("nu amestecă destinația clientului în textul ofertei", () => {
    expect(JSON.stringify(pickup)).not.toContain("Cluj");
  });

  it("oferta de curier nu are linie de adresă", () => {
    expect(dto.offers.find((o) => o.kind === "courier")?.addressLine).toBeNull();
  });

  it("eticheta ofertei rămâne «Ridicare personală»", () => {
    expect(pickup?.label).toBe("Ridicare personală");
  });
});
