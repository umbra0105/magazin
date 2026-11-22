import { describe, expect, it } from "vitest";
import { IntegrationError, type CarrierQuote, type ShippingCarrier } from "@ecom/shared";
import { CarrierRuntime, type CarrierSource } from "./carrier-runtime";
import type { RateRequest } from "./types";

const request: RateRequest = {
  parcels: [
    {
      variantId: "v",
      sku: "S",
      shippingClass: "standard",
      realGrams: 1000,
      volumetricGrams: 0,
      chargeableGrams: 1000,
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
const quote: CarrierQuote = {
  serviceCode: "9",
  courier: "Curier",
  service: "Standard",
  kind: "courier",
  priceMinor: 1500,
  estimatedDays: 1,
  codFeeMinor: 0,
};

function fakeCarrier(behavior: () => Promise<CarrierQuote[]>) {
  const state = { quotes: 0, awbs: 0 };
  const carrier = {
    code: "wootpro",
    label: "wootPRO",
    quote: async () => {
      state.quotes += 1;
      return behavior();
    },
    createAwb: async () => {
      state.awbs += 1;
      throw new IntegrationError("SHIPPING_PROVIDER_UNREACHABLE", "jos");
    },
  } as unknown as ShippingCarrier;
  return { carrier, state };
}

function runtime(source: CarrierSource, over: { now?: () => number } = {}) {
  return new CarrierRuntime({
    source,
    readCacheSeconds: async () => 0,
    threshold: 2,
    openMs: 60_000,
    instanceTtlMs: 1000,
    ...over,
  });
}

describe("curierii în execuție", () => {
  it("fără curier activ: tarifele DEMO, marcate «DEMO», ca până acum", async () => {
    const rt = runtime({ activeCarrier: async () => null, getCarrier: async () => null });
    const offers = await rt.rateProvider().quote(request, signal);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.demo)).toBe(true);
  });

  it("cu curier activ: tarifele lui, cu cod `<curier>:<serviciu>`", async () => {
    const { carrier } = fakeCarrier(async () => [quote]);
    const rt = runtime({
      activeCarrier: async () => ({ code: "wootpro", mode: "test" }),
      getCarrier: async () => carrier,
    });
    const offers = await rt.rateProvider().quote(request, signal);
    expect(offers.map((o) => [o.code, o.priceMinor, o.demo])).toEqual([["wootpro:9", 1500, false]]);
  });

  it("întrerupătorul e UNUL pe curier: căderile la AWB opresc și tarifele (checkout cade pe rezerva pe zone)", async () => {
    const { carrier, state } = fakeCarrier(async () => [quote]);
    const rt = runtime({
      activeCarrier: async () => ({ code: "wootpro", mode: "test" }),
      getCarrier: async () => carrier,
    });
    const guarded = await rt.activeCarrier();
    for (let i = 0; i < 2; i += 1) {
      await guarded?.createAwb({} as never).catch(() => undefined);
    }
    await expect(rt.rateProvider().quote(request, signal)).rejects.toMatchObject({
      code: "SHIPPING_CIRCUIT_OPEN",
    });
    expect(state.quotes).toBe(0);
    expect(state.awbs).toBe(2);
  });

  it("instanța se reface după TTL (credențiale schimbate) și la `invalidate`", async () => {
    let built = 0;
    let now = 0;
    const rt = runtime(
      {
        activeCarrier: async () => ({ code: "wootpro", mode: "test" }),
        getCarrier: async () => {
          built += 1;
          return fakeCarrier(async () => [quote]).carrier;
        },
      },
      { now: () => now },
    );
    await rt.carrier("wootpro");
    await rt.carrier("wootpro");
    expect(built).toBe(1);
    now += 1500;
    await rt.carrier("wootpro");
    expect(built).toBe(2);
    rt.invalidate();
    await rt.carrier("wootpro");
    expect(built).toBe(3);
  });

  it("un curier care nu mai e configurat dispare din execuție", async () => {
    let configured = true;
    const rt = runtime({
      activeCarrier: async () => null,
      getCarrier: async () => (configured ? fakeCarrier(async () => []).carrier : null),
    });
    expect(await rt.carrier("wootpro")).not.toBeNull();
    configured = false;
    rt.invalidate();
    expect(await rt.carrier("wootpro")).toBeNull();
  });
});
