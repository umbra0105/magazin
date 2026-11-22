import { describe, expect, it } from "vitest";
import { IntegrationError, type CarrierQuote, type ShippingCarrier } from "@ecom/shared";
import { CircuitBreaker, CarrierRateProvider, GuardedCarrier } from "./carrier-guard";
import { RateRefusedError, type RateRequest } from "./types";

const quote = (over: Partial<CarrierQuote> = {}): CarrierQuote => ({
  serviceCode: "42",
  courier: "Curier",
  service: "Standard",
  kind: "courier",
  priceMinor: 2380,
  estimatedDays: 2,
  codFeeMinor: 0,
  ...over,
});

function fakeCarrier(
  quotes: () => Promise<CarrierQuote[]>,
  code: "wootpro" | "demo" = "wootpro",
): ShippingCarrier & { calls: number } {
  const state = { calls: 0 };
  const carrier = {
    code,
    label: "Fals",
    get calls() {
      return state.calls;
    },
    async quote() {
      state.calls += 1;
      return quotes();
    },
    async createAwb() {
      state.calls += 1;
      throw new IntegrationError("SHIPPING_PROVIDER_UNREACHABLE", "x");
    },
    getLabel: () => Promise.reject(new Error("n/a")),
    track: () => Promise.reject(new Error("n/a")),
    cancel: () => Promise.resolve(),
    createReturnAwb: () => Promise.reject(new Error("n/a")),
    listPickupPoints: () => Promise.resolve([]),
    testConnection: () => Promise.resolve({ ok: true, message: "ok" }),
  };
  return carrier as unknown as ShippingCarrier & { calls: number };
}

const down = () => Promise.reject(new IntegrationError("SHIPPING_PROVIDER_UNREACHABLE", "jos"));

const request: RateRequest = {
  parcels: [
    {
      variantId: "v",
      sku: "S",
      shippingClass: "standard",
      realGrams: 2000,
      volumetricGrams: 0,
      chargeableGrams: 2000,
      volumeCm3: 0,
      wholeUnits: 1,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      incomplete: false,
    },
  ],
  county: { code: 1, name: "Alba" },
  locality: { code: 2, name: "Alba Iulia" },
  postalCode: "510005",
  codAmountMinor: 0,
};
const signal = new AbortController().signal;

describe("întrerupătorul de circuit: curier picat ≠ comandă pierdută", () => {
  it("după 3 căderi la rând se deschide și refuză imediat, fără să mai apeleze curierul", async () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker({ threshold: 3, openMs: 60_000, now: () => now });
    const carrier = new GuardedCarrier(fakeCarrier(down), breaker);
    for (let i = 0; i < 3; i += 1) {
      await expect(carrier.quote(request2(), signal)).rejects.toMatchObject({
        code: "SHIPPING_PROVIDER_UNREACHABLE",
      });
    }
    await expect(carrier.quote(request2(), signal)).rejects.toMatchObject({
      code: "SHIPPING_CIRCUIT_OPEN",
    });
    now += 59_000;
    await expect(carrier.quote(request2(), signal)).rejects.toMatchObject({
      code: "SHIPPING_CIRCUIT_OPEN",
    });
  });

  it("după fereastra de așteptare lasă UN apel de probă; dacă reușește, se închide", async () => {
    let now = 0;
    let healthy = false;
    const breaker = new CircuitBreaker({ threshold: 2, openMs: 1000, now: () => now });
    const inner = fakeCarrier(() => (healthy ? Promise.resolve([quote()]) : down()));
    const carrier = new GuardedCarrier(inner, breaker);
    await carrier.quote(request2(), signal).catch(() => undefined);
    await carrier.quote(request2(), signal).catch(() => undefined);
    expect(breaker.isOpen()).toBe(true);
    now += 1500;
    healthy = true;
    await expect(carrier.quote(request2(), signal)).resolves.toHaveLength(1);
    expect(breaker.isOpen()).toBe(false);
  });

  it("proba eșuată redeschide întrerupătorul pentru încă o fereastră", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ threshold: 1, openMs: 1000, now: () => now });
    const carrier = new GuardedCarrier(fakeCarrier(down), breaker);
    await carrier.quote(request2(), signal).catch(() => undefined);
    now += 1500;
    await carrier.quote(request2(), signal).catch(() => undefined); // proba
    await expect(carrier.quote(request2(), signal)).rejects.toMatchObject({
      code: "SHIPPING_CIRCUIT_OPEN",
    });
  });

  it("un REFUZ al tarifei nu e o cădere: nu deschide întrerupătorul", async () => {
    const breaker = new CircuitBreaker({ threshold: 2, openMs: 1000, now: () => 0 });
    const refusing = fakeCarrier(() =>
      Promise.reject(new IntegrationError("SHIPPING_REFUSED", "prea greu")),
    );
    const carrier = new GuardedCarrier(refusing, breaker);
    for (let i = 0; i < 5; i += 1) await carrier.quote(request2(), signal).catch(() => undefined);
    expect(breaker.isOpen()).toBe(false);
    expect(refusing.calls).toBe(5);
  });

  it("un succes oprește numărătoarea căderilor consecutive", async () => {
    let fail = true;
    const breaker = new CircuitBreaker({ threshold: 2, openMs: 1000, now: () => 0 });
    const inner = fakeCarrier(() => (fail ? down() : Promise.resolve([quote()])));
    const carrier = new GuardedCarrier(inner, breaker);
    await carrier.quote(request2(), signal).catch(() => undefined);
    fail = false;
    await carrier.quote(request2(), signal);
    fail = true;
    await carrier.quote(request2(), signal).catch(() => undefined);
    expect(breaker.isOpen()).toBe(false);
  });
});

function request2() {
  return {
    parcels: [{ weightGrams: 2000, lengthMm: null, widthMm: null, heightMm: null }],
    destination: { countyName: "Alba", localityName: "Alba Iulia", postalCode: "510005" },
    codAmountMinor: 0,
  };
}

describe("furnizorul de tarife peste curier", () => {
  it("transformă tarifele în oferte cu cod stabil, sursă «provider», DEMO doar la curierul DEMO", async () => {
    const provider = new CarrierRateProvider({
      carrier: fakeCarrier(() =>
        Promise.resolve([quote(), quote({ serviceCode: "43", kind: "easybox" })]),
      ),
      breaker: new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => 0 }),
      cacheSeconds: 0,
      now: () => 0,
    });
    const offers = await provider.quote(request, signal);
    expect(offers.map((o) => [o.code, o.kind, o.priceMinor, o.source, o.demo])).toEqual([
      ["wootpro:42", "courier", 2380, "provider", false],
      ["wootpro:43", "easybox", 2380, "provider", false],
    ]);
    const demo = new CarrierRateProvider({
      carrier: fakeCarrier(() => Promise.resolve([quote()]), "demo"),
      breaker: new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => 0 }),
      cacheSeconds: 0,
      now: () => 0,
    });
    expect((await demo.quote(request, signal))[0]?.demo).toBe(true);
  });

  it("tarifele se păstrează în cache scurt: aceleași colete și aceeași destinație nu mai apelează curierul", async () => {
    let now = 0;
    const inner = fakeCarrier(() => Promise.resolve([quote()]));
    const provider = new CarrierRateProvider({
      carrier: inner,
      breaker: new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => now }),
      cacheSeconds: 120,
      now: () => now,
    });
    await provider.quote(request, signal);
    await provider.quote(request, signal);
    expect(inner.calls).toBe(1);
    now += 121_000;
    await provider.quote(request, signal);
    expect(inner.calls).toBe(2);
    await provider.quote({ ...request, codAmountMinor: 5000 }, signal);
    expect(inner.calls).toBe(3);
  });

  it("refuzul curierului devine RateRefusedError (cere paletizat sau rezervă)", async () => {
    const provider = new CarrierRateProvider({
      carrier: fakeCarrier(() => Promise.reject(new IntegrationError("SHIPPING_REFUSED", "nu"))),
      breaker: new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => 0 }),
      cacheSeconds: 0,
      now: () => 0,
    });
    await expect(provider.quote(request, signal)).rejects.toBeInstanceOf(RateRefusedError);
  });

  it("o localitate nemapată sau o cădere NU sunt refuz: se propagă, serviciul cade pe rezerva pe zone", async () => {
    const provider = new CarrierRateProvider({
      carrier: fakeCarrier(() =>
        Promise.reject(new IntegrationError("SHIPPING_LOCATION_UNMAPPED", "?")),
      ),
      breaker: new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => 0 }),
      cacheSeconds: 0,
      now: () => 0,
    });
    const error = await provider.quote(request, signal).catch((e) => e);
    expect(error).not.toBeInstanceOf(RateRefusedError);
    expect(error).toMatchObject({ code: "SHIPPING_LOCATION_UNMAPPED" });
  });

  it("coletele trimise curierului poartă greutatea tarifabilă (cea mai mare dintre reală și volumetrică)", async () => {
    let seen: unknown = null;
    const inner = fakeCarrier(() => Promise.resolve([quote()]));
    inner.quote = async (req) => {
      seen = req;
      return [quote()];
    };
    const provider = new CarrierRateProvider({
      carrier: inner,
      breaker: new CircuitBreaker({ threshold: 3, openMs: 1000, now: () => 0 }),
      cacheSeconds: 0,
      now: () => 0,
    });
    const heavy = {
      ...request.parcels[0]!,
      realGrams: 2000,
      volumetricGrams: 9000,
      chargeableGrams: 9000,
    };
    await provider.quote({ ...request, parcels: [heavy] }, signal);
    expect(seen).toMatchObject({
      parcels: [{ weightGrams: 9000 }],
      destination: { countyName: "Alba", localityName: "Alba Iulia", postalCode: "510005" },
    });
  });
});
