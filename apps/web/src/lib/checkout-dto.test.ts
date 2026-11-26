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
    text: "Strada Exemplu 1, 510000 Alba Iulia, Alba",
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
      "Adresa de ridicare: Strada Exemplu 1, 510000 Alba Iulia, Alba",
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

describe("programul de ridicare în oferta de ridicare (Faza 13)", () => {
  const build = (pickupHours: string | null) =>
    toCheckoutPreviewDto(preview([offer(), PICKUP], PICKUP), { ...FORMAT, pickupHours }, LIMITS, {
      isCompany: false,
    }).offers;

  it("apare lângă adresa de ridicare, doar când e completat", () => {
    const pickup = build("Luni–Vineri, 09:00–17:00").find((o) => o.kind === "pickup");
    expect(pickup?.hoursLine).toBe("Program de ridicare: Luni–Vineri, 09:00–17:00");
    expect(build(null).find((o) => o.kind === "pickup")?.hoursLine).toBeNull();
    expect(build("").find((o) => o.kind === "pickup")?.hoursLine).toBeNull();
  });

  it("oferta de curier nu are program", () => {
    expect(build("Luni–Vineri").find((o) => o.kind === "courier")?.hoursLine).toBeNull();
  });
});

/** Rambursul la ridicare (decizia din 2026-11-19): rămâne oferit, dar cu textul «în magazin», nu «curierului». */
describe("rambursul oferit la ridicarea personală", () => {
  const withMethods = (selected: RateOffer, fee: number) =>
    toCheckoutPreviewDto(
      {
        ...preview([offer({ codFeeMinor: fee }), PICKUP], selected),
        methods: [{ method: "cod", available: true, reason: null }],
      } as unknown as CheckoutPreview,
      FORMAT,
      LIMITS,
      { isCompany: false },
    ).methods?.find((m) => m.method === "cod");

  it("la ridicare: «Plătești în magazin la ridicare», fără «curierului»", () => {
    const cod = withMethods(PICKUP, 0);
    expect(cod?.available).toBe(true);
    expect(cod?.helpText).toBe("Plătești în magazin la ridicare.");
    expect(cod?.helpText).not.toMatch(/curier/i);
  });

  it("la ridicare cu taxă de ramburs, taxa se arată tot cu textul din magazin", () => {
    const cod = withMethods({ ...PICKUP, codFeeMinor: 500 }, 0);
    expect(cod?.helpText).toMatch(/^Plătești în magazin la ridicare\. Taxă de ramburs: /);
  });

  it("la livrare cu curier rămâne «curierului»", () => {
    const courier = offer();
    expect(withMethods(courier, 0)?.helpText).toBe("Plătești curierului la primirea coletului.");
  });
});

/** Transportul paletizat (decizia din 2026-11-22): rambursul rămâne, dar doar cu cardul la livrare (textul, nu suma). */
describe("rambursul la transportul paletizat", () => {
  const PALLET: RateOffer = offer({
    code: "pallet",
    kind: "pallet",
    carrier: "Transport paletizat",
    service: "marfă grea sau voluminoasă",
    priceMinor: 70_000,
    estimatedDays: null,
    source: "pallet",
    demo: false,
    pallets: 2,
  });
  const dtoFor = (selected: RateOffer) =>
    toCheckoutPreviewDto(
      {
        ...preview([selected, PICKUP], selected),
        methods: [{ method: "cod", available: true, reason: null }],
      } as unknown as CheckoutPreview,
      FORMAT,
      LIMITS,
      { isCompany: false },
    );

  it("oferta se numește «Transport paletizat (marfă grea sau voluminoasă)» și arată numărul de paleți", () => {
    const offerDto = dtoFor(PALLET).offers.find((o) => o.kind === "pallet");
    expect(offerDto?.label).toBe("Transport paletizat (marfă grea sau voluminoasă)");
    expect(offerDto?.daysText).toBe("Estimare: 2 paleți.");
    expect(offerDto?.demo).toBe(false);
  });

  it("rambursul rămâne disponibil, cu textul «doar cu cardul; curierul nu acceptă numerar»", () => {
    const cod = dtoFor(PALLET).methods?.find((m) => m.method === "cod");
    expect(cod?.available).toBe(true);
    expect(cod?.helpText).toBe("Plata la livrare doar cu cardul; curierul nu acceptă numerar.");
    expect(cod?.helpText).not.toMatch(/Plătești curierului/);
  });

  it("cu taxă de ramburs, textul rămâne, iar taxa se arată", () => {
    const cod = dtoFor({ ...PALLET, codFeeMinor: 500 }).methods?.find((m) => m.method === "cod");
    expect(cod?.helpText).toMatch(
      /^Plata la livrare doar cu cardul; curierul nu acceptă numerar\. Taxă de ramburs: /,
    );
  });

  it("un singur palet: «1 palet»", () => {
    const one = dtoFor({ ...PALLET, pallets: 1 }).offers.find((o) => o.kind === "pallet");
    expect(one?.daysText).toBe("Estimare: 1 palet.");
  });
});

describe("punctele de loialitate în previzualizare (Faza 15b)", () => {
  const withLoyalty = (loyalty: CheckoutPreview["loyalty"], discountMinor?: number) =>
    ({
      ...preview([offer()], offer()),
      ...(loyalty ? { loyalty } : {}),
      totals: {
        subtotalMinor: 20_000,
        ...(discountMinor ? { discountMinor } : {}),
        shippingMinor: 2_500,
        codFeeMinor: 0,
        shippingTaxMinor: 434,
        codFeeTaxMinor: 0,
        taxMinor: 3_037,
        totalMinor: 22_500 - (discountMinor ?? 0),
      },
    }) as CheckoutPreview;
  const dto = (loyalty: CheckoutPreview["loyalty"], discountMinor?: number) =>
    toCheckoutPreviewDto(withLoyalty(loyalty, discountMinor), FORMAT, LIMITS, { isCompany: false });
  const member = {
    signedIn: true,
    earns: true,
    balance: 120,
    redeem: { maxPoints: 50, minPoints: 10, pointValueMinor: 100 },
    appliedPoints: 50,
    earnEstimate: 1,
  };
  const spaces = (text: string | null | undefined) => (text ?? "").replace(/\s/g, " ");

  it("fără program (sau program oprit): niciun bloc și nicio linie de reducere", () => {
    const result = dto(undefined);
    expect(result.loyalty).toBeNull();
    expect(result.totals?.discountText).toBeNull();
  });

  it("clientul cu sold: întrebarea cu punctele și leii, maximul, reducerea ca linie separată și ce primește", () => {
    const result = dto(member, 5_000);
    expect(spaces(result.loyalty?.redeem?.balanceText)).toBe(
      "Ai 120 de puncte (120,00 RON). Folosește-le?",
    );
    expect(spaces(result.loyalty?.redeem?.maxText)).toContain("cel mult 50 de puncte (50,00 RON)");
    expect(result.loyalty?.redeem).toMatchObject({ maxPoints: 50, minPoints: 10 });
    expect(spaces(result.loyalty?.appliedText)).toBe("Folosești 50 de puncte: −50,00 RON");
    expect(spaces(result.totals?.discountText)).toBe("−50,00 RON");
    expect(spaces(result.totals?.productsText)).toBe("200,00 RON");
    expect(result.totals?.totalMinor).toBe(17_500);
    expect(result.loyalty?.note).toBe("Primești 1 punct la această comandă.");
  });

  it("oaspetele vede «Creează cont și primești X puncte», fără slider", () => {
    const result = dto({
      signedIn: false,
      earns: true,
      balance: 0,
      redeem: null,
      appliedPoints: 0,
      earnEstimate: 2,
    });
    expect(result.loyalty).toMatchObject({ redeem: null, appliedText: null });
    expect(result.loyalty?.note).toBe("Creează cont și primești 2 puncte la o comandă ca aceasta.");
  });

  it("Partenerul nu vede nimic despre acumulare; sub un punct nu se promite nimic", () => {
    expect(
      dto({ ...member, earns: false, earnEstimate: 0, redeem: null, appliedPoints: 0 }).loyalty,
    ).toEqual({ redeem: null, appliedPoints: 0, appliedText: null, note: null });
    expect(dto({ ...member, earnEstimate: 0 }).loyalty?.note).toBeNull();
  });
});
