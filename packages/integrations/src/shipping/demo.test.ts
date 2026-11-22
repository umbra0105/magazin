import { describe, expect, it } from "vitest";
import { demoAwbCreatedAt, DemoCarrier, demoPickupPoints } from "./demo";
import { buildShippingCarrier } from "./registry";

const T0 = new Date("2030-01-01T10:00:00Z");
const env = { E2E_HARNESS: "1" };
const request = {
  reference: "WEB-1",
  recipient: {
    name: "N",
    phone: "1",
    street: "S",
    countyName: "Alba",
    localityName: "Alba Iulia",
    postalCode: "1",
  },
  parcels: [{ weightGrams: 1000, lengthMm: null, widthMm: null, heightMm: null }],
  codAmountMinor: 0,
  declaredValueMinor: 0,
};

describe("curierul DEMO", () => {
  it("nu există în producție: garda refuză construirea", () => {
    expect(() => new DemoCarrier({ env: { NODE_ENV: "production" } })).toThrow();
    expect(
      () => new DemoCarrier({ env: { NODE_ENV: "production", ECOM_DEMO_PAYMENTS: "1" } }),
    ).toThrow();
    expect(() => new DemoCarrier({ env })).not.toThrow();
    expect(
      () => new DemoCarrier({ env: { NODE_ENV: "development", ECOM_DEMO_PAYMENTS: "1" } }),
    ).not.toThrow();
  });

  it("fabrica nu construiește DEMO fără gardă", () => {
    expect(() =>
      buildShippingCarrier({
        code: "demo",
        credentials: {},
        mode: "test",
        env: { NODE_ENV: "production" },
      }),
    ).toThrow();
  });

  it("AWB cu momentul creării în număr; urmărirea derivă starea din timpul scurs", async () => {
    let now = T0;
    const carrier = new DemoCarrier({ env, now: () => now });
    const { awb } = await carrier.createAwb(request);
    expect(demoAwbCreatedAt(awb)?.getTime()).toBe(T0.getTime());
    const at = async (seconds: number) => {
      now = new Date(T0.getTime() + seconds * 1000);
      return carrier.track({ awb, providerRef: awb });
    };
    expect((await at(0)).status).toBe("created");
    expect((await at(130)).status).toBe("picked_up");
    expect((await at(310)).status).toBe("in_transit");
    const done = await at(700);
    expect(done.status).toBe("delivered");
    expect(done.events.map((e) => e.key)).toEqual([
      `${awb}:created`,
      `${awb}:picked_up`,
      `${awb}:in_transit`,
      `${awb}:delivered`,
    ]);
  });

  it("etichetele: PDF valid ca început și ZPL", async () => {
    const carrier = new DemoCarrier({ env });
    const pdf = await carrier.getLabel({ awb: "DEMO0000000001001", providerRef: null }, "pdf");
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    const zpl = await carrier.getLabel({ awb: "DEMO0000000001001", providerRef: null }, "zpl");
    expect(Buffer.from(zpl.bytes).toString()).toMatch(/^\^XA.*\^XZ$/);
  });

  it("punctele easybox sunt simulate și se filtrează", async () => {
    const carrier = new DemoCarrier({ env });
    const alba = await carrier.listPickupPoints({ countyName: "Alba", localityName: "Alba Iulia" });
    expect(alba.length).toBeGreaterThan(1);
    expect(demoPickupPoints().every((p) => p.name.includes("Demo"))).toBe(true);
  });
});
