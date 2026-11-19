import { describe, expect, it } from "vitest";
import { DEMO_RATE_CARD, DemoShippingRateProvider } from "./demo-rates";
import type { FallbackZone } from "./fallback-tariffs";
import {
  ShippingService,
  type ShippingQuoteInput,
  type ShippingRuntimeSettings,
  type ShippingStore,
} from "./shipping-service";
import type { Parcel, RateOffer, RateRequest, ShippingRateProvider } from "./types";

const parcel = (over: Partial<Parcel> = {}): Parcel => ({
  variantId: "v1",
  sku: "S1",
  shippingClass: "standard",
  realGrams: 2000,
  volumetricGrams: 0,
  chargeableGrams: 2000,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
  incomplete: false,
  ...over,
});

const settings = (over: Partial<ShippingRuntimeSettings> = {}): ShippingRuntimeSettings => ({
  freeShippingThresholdMinor: null,
  freeShippingClasses: ["standard"],
  pickupEnabled: true,
  pickupAddress: {
    street: "Strada Exemplu 1",
    city: "Alba Iulia",
    county: "Alba",
    postalCode: "510000",
    country: "RO",
  },
  easyboxEnabled: false,
  quoteTimeoutMs: 50,
  ...over,
});

const zones: FallbackZone[] = [
  {
    id: "z",
    name: "Zona test",
    isActive: true,
    countyCodes: [10],
    methods: [
      {
        id: "m",
        code: "zona-test",
        name: "Curier zonă",
        carrier: "Curier propriu",
        type: "flat",
        priceMinor: 2200,
        rules: {},
        freeAboveMinor: null,
        codFeeMinor: 400,
        estimatedDays: 3,
        isActive: true,
      },
    ],
  },
];

function service(options: {
  provider?: ShippingRateProvider;
  settings?: Partial<ShippingRuntimeSettings>;
  zones?: FallbackZone[];
  excluded?: string[];
}) {
  const store: ShippingStore = {
    zones: async () => options.zones ?? zones,
    excludedProductIds: async () => options.excluded ?? [],
  };
  return new ShippingService({
    provider: options.provider ?? new DemoShippingRateProvider(),
    store,
    readSettings: async () => settings(options.settings),
  });
}

const input = (over: Partial<ShippingQuoteInput> = {}): ShippingQuoteInput => ({
  parcels: [parcel()],
  lines: [{ productId: "p1", shippingClass: "standard" }],
  subtotalMinor: 10_000,
  destination: {
    county: { code: 10, name: "Alba" },
    locality: { code: 1026, name: "Alba Iulia" },
    postalCode: "510005",
  },
  ...over,
});

const providerOffer = (over: Partial<RateOffer> = {}): RateOffer => ({
  code: "p:1",
  kind: "courier",
  carrier: "Curier real",
  service: "Standard",
  priceMinor: 1900,
  estimatedDays: 1,
  codFeeMinor: 300,
  source: "provider",
  demo: false,
  freeShipping: false,
  ...over,
});

describe("furnizorul răspunde", () => {
  it("întoarce ofertele furnizorului, plus ridicarea personală, sortate după preț", async () => {
    const quote = await service({
      provider: {
        name: "x",
        quote: async () => [providerOffer(), providerOffer({ code: "p:2", priceMinor: 1500 })],
      },
    }).quote(input());
    expect(quote.fallbackUsed).toBe(false);
    expect(quote.offers.map((o) => [o.code, o.priceMinor])).toEqual([
      ["pickup", 0],
      ["p:2", 1500],
      ["p:1", 1900],
    ]);
  });

  it("furnizorul DEMO: ofertele sunt marcate DEMO, easybox rămâne ascuns", async () => {
    const quote = await service({}).quote(input());
    const courier = quote.offers.find((o) => o.code === "demo:courier");
    expect(courier).toMatchObject({ demo: true, priceMinor: DEMO_RATE_CARD.courier.baseMinor });
    expect(courier?.service).toContain("DEMO");
    expect(quote.offers.some((o) => o.kind === "easybox")).toBe(false);
  });

  it("produsele voluminoase merg pe marfă și nu au easybox, chiar cu easybox activat", async () => {
    const quote = await service({ settings: { easyboxEnabled: true } }).quote(
      input({
        parcels: [parcel({ shippingClass: "pallet", chargeableGrams: 60_000 })],
        lines: [{ productId: "p1", shippingClass: "pallet" }],
      }),
    );
    expect(quote.offers.map((o) => o.kind).sort()).toEqual(["courier", "pickup"]);
    expect(quote.offers.find((o) => o.code === "demo:freight")).toBeDefined();
  });

  it("easybox activat și coș standard: oferta easybox apare", async () => {
    const quote = await service({ settings: { easyboxEnabled: true } }).quote(input());
    expect(quote.offers.some((o) => o.kind === "easybox")).toBe(true);
  });

  it("ridicarea personală dispare când e dezactivată din setări", async () => {
    const quote = await service({ settings: { pickupEnabled: false } }).quote(input());
    expect(quote.offers.some((o) => o.kind === "pickup")).toBe(false);
  });
});

describe("ridicarea personală și adresa magazinului (`company.address`)", () => {
  const pickupOf = async (over: Partial<ShippingRuntimeSettings>) =>
    (await service({ settings: over }).quote(input())).offers.find((o) => o.kind === "pickup");

  it("oferta poartă adresa magazinului, formatată, nu adresa clientului", async () => {
    const offer = await pickupOf({});
    expect(offer?.pickupAddress).toEqual({
      street: "Strada Exemplu 1",
      city: "Alba Iulia",
      county: "Alba",
      postalCode: "510000",
      country: "RO",
      text: "Strada Exemplu 1, 510000 Alba Iulia, Alba",
    });
    // destinația clientului (Alba Iulia, 510005) nu intră nicăieri în oferta de ridicare
    expect(JSON.stringify(offer)).not.toContain("510005");
  });

  it("fără adresă (null) ridicarea NU se oferă, chiar cu ridicarea activată", async () => {
    expect(await pickupOf({ pickupAddress: null })).toBeUndefined();
  });

  it("strada sau orașul goale, sau doar spații: ridicarea NU se oferă", async () => {
    const base = {
      street: "Strada Exemplu 1",
      city: "Alba Iulia",
      county: "",
      postalCode: "",
      country: "RO",
    };
    expect(await pickupOf({ pickupAddress: { ...base, street: "" } })).toBeUndefined();
    expect(await pickupOf({ pickupAddress: { ...base, city: "   " } })).toBeUndefined();
    expect(await pickupOf({ pickupAddress: { ...base, street: " ", city: "" } })).toBeUndefined();
  });

  it("județul și codul poștal goale nu opresc ridicarea", async () => {
    const offer = await pickupOf({
      pickupAddress: {
        street: "Strada Exemplu 1",
        city: "Alba Iulia",
        county: "",
        postalCode: "",
        country: "RO",
      },
    });
    expect(offer?.pickupAddress?.text).toBe("Strada Exemplu 1, Alba Iulia");
  });

  it("ofertele de curier nu poartă adresă de ridicare", async () => {
    const quote = await service({}).quote(input());
    for (const offer of quote.offers.filter((o) => o.kind !== "pickup")) {
      expect(offer.pickupAddress).toBeUndefined();
    }
  });
});

describe("furnizorul nu răspunde: checkout-ul nu se blochează niciodată", () => {
  const failing: ShippingRateProvider = {
    name: "picat",
    quote: async () => {
      throw new Error("503");
    },
  };

  it("eroare → tarifele pe zona județului", async () => {
    const quote = await service({ provider: failing }).quote(input());
    expect(quote.fallbackUsed).toBe(true);
    expect(quote.offers.find((o) => o.code === "fallback:zona-test")).toMatchObject({
      priceMinor: 2200,
      source: "fallback",
    });
  });

  it("timp depășit → rezerva pe zonă", async () => {
    const slow: ShippingRateProvider = {
      name: "lent",
      quote: (_request: RateRequest, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("anulat")));
        }),
    };
    const quote = await service({ provider: slow, settings: { quoteTimeoutMs: 20 } }).quote(
      input(),
    );
    expect(quote.fallbackUsed).toBe(true);
    expect(quote.offers.some((o) => o.code === "fallback:zona-test")).toBe(true);
  });

  it("răspuns gol → rezerva pe zonă", async () => {
    const quote = await service({ provider: { name: "gol", quote: async () => [] } }).quote(
      input(),
    );
    expect(quote.fallbackUsed).toBe(true);
  });

  it("județ fără zonă → oferta de ultimă instanță (DEMO), mereu cel puțin o ofertă", async () => {
    const quote = await service({ provider: failing, zones: [] }).quote(
      input({
        destination: {
          county: { code: 99, name: "Fără zonă" },
          locality: { code: 1, name: "X" },
          postalCode: "123456",
        },
      }),
    );
    const paid = quote.offers.filter((o) => o.kind === "courier");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ code: "demo:last-resort", demo: true, source: "last_resort" });
  });

  it("fără ridicare și fără zonă, tot rămâne o ofertă", async () => {
    const quote = await service({
      provider: failing,
      zones: [],
      settings: { pickupEnabled: false },
    }).quote(input());
    expect(quote.offers.length).toBeGreaterThan(0);
  });
});

describe("pragul de transport gratuit", () => {
  const provider: ShippingRateProvider = { name: "x", quote: async () => [providerOffer()] };

  it("curierul devine gratuit când pragul e atins și liniile sunt eligibile", async () => {
    const quote = await service({
      provider,
      settings: { freeShippingThresholdMinor: 10_000 },
    }).quote(input({ subtotalMinor: 10_000 }));
    expect(quote.freeShipping).toEqual({ eligible: true });
    expect(quote.offers.find((o) => o.code === "p:1")).toMatchObject({
      priceMinor: 0,
      freeShipping: true,
      codFeeMinor: 300,
    });
  });

  it("sub prag: plătit; produs oversized: plătit chiar peste prag", async () => {
    const below = await service({
      provider,
      settings: { freeShippingThresholdMinor: 10_000 },
    }).quote(input({ subtotalMinor: 9_999 }));
    expect(below.offers.find((o) => o.code === "p:1")?.priceMinor).toBe(1900);
    const heavy = await service({
      provider,
      settings: { freeShippingThresholdMinor: 10_000 },
    }).quote(
      input({
        subtotalMinor: 800_000,
        lines: [{ productId: "p1", shippingClass: "oversized" }],
      }),
    );
    expect(heavy.freeShipping).toEqual({ eligible: false, reason: "class_excluded" });
    expect(heavy.offers.find((o) => o.code === "p:1")?.priceMinor).toBe(1900);
  });

  it("un produs exclus din admin dezactivează scutirea", async () => {
    const quote = await service({
      provider,
      excluded: ["p1"],
      settings: { freeShippingThresholdMinor: 10_000 },
    }).quote(input({ subtotalMinor: 50_000 }));
    expect(quote.freeShipping).toEqual({ eligible: false, reason: "product_excluded" });
  });

  it("scutirea se aplică și ofertelor de rezervă", async () => {
    const quote = await service({
      provider: { name: "x", quote: async () => [] },
      settings: { freeShippingThresholdMinor: 5_000 },
    }).quote(input({ subtotalMinor: 5_000 }));
    expect(quote.offers.find((o) => o.code === "fallback:zona-test")?.priceMinor).toBe(0);
  });
});

describe("coletele incomplete", () => {
  it("raportează că tariful poate fi subestimat, fără să blocheze", async () => {
    const quote = await service({}).quote(input({ parcels: [parcel({ incomplete: true })] }));
    expect(quote.incomplete).toBe(true);
    expect(quote.offers.length).toBeGreaterThan(0);
  });
});
