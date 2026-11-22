import { describe, expect, it } from "vitest";
import type { CarrierAwbRequest } from "@ecom/shared";
import { WootproCarrier, wootproStatus, WOOTPRO_STAGING_URL } from "./wootpro";

/**
 * Teste de CONTRACT pe răspunsuri SIMULATE (fixture-uri scrise după specificația OpenAPI wootPRO, citită pe 2026-11-22). Nu
 * dovedesc nimic despre API-ul real: adaptorul rămâne «încă netestat cu cont real».
 */
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const method = String(init.method ?? "GET");
    const call: Call = {
      method,
      url,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    const path = url.replace(WOOTPRO_STAGING_URL, "").split("?")[0] ?? "";
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ error: "necunoscut" }), { status: 404 });
    const out = route(call);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const AUTH = {
  "POST /account/authorize": () => ({ body: { success: true, token: "tok-1", expire: 86400 } }),
};
const COUNTIES = {
  "GET /general/counties": () => ({
    body: [
      { id: 1, name: "Alba" },
      { id: 2, name: "Cluj" },
    ],
  }),
};
const CITIES = {
  "GET /general/cities": () => ({
    body: [
      { id: 10, name: "Alba Iulia" },
      { id: 11, name: "Sebeș" },
    ],
  }),
};

const make = (routes: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch({ ...AUTH, ...COUNTIES, ...CITIES, ...routes });
  const carrier = new WootproCarrier({
    credentials: { publicKey: "p".repeat(32), secretKey: "s".repeat(32), senderAddressId: "77" },
    mode: "test",
    fetch: f.fetchImpl,
    now: () => new Date("2030-01-01T10:00:00Z"),
  });
  return { carrier, calls: f.calls };
};

const destination = { countyName: "Alba", localityName: "Alba Iulia", postalCode: "510005" };
const parcels = [{ weightGrams: 12_500, lengthMm: 300, widthMm: 300, heightMm: 200 }];
const awbRequest: CarrierAwbRequest = {
  reference: "WEB-0001",
  recipient: {
    ...destination,
    name: "Ion Popescu",
    phone: "0722123456",
    street: "Str. Exemplu 1",
    email: "ion@exemplu.ro",
  },
  parcels,
  codAmountMinor: 123_45,
  declaredValueMinor: 123_45,
  serviceCode: "42",
};

describe("wootPRO: autentificare", () => {
  it("cere token cu cheile din cont, îl trimite ca Bearer și îl refolosește", async () => {
    const { carrier, calls } = make({
      "POST /orders/prices": () => ({ body: [] }),
    });
    await carrier.quote({ parcels, destination, codAmountMinor: 0 }).catch(() => undefined);
    await carrier.quote({ parcels, destination, codAmountMinor: 0 }).catch(() => undefined);
    const auth = calls.filter((c) => c.url.endsWith("/account/authorize"));
    expect(auth).toHaveLength(1);
    expect(JSON.parse(auth[0]?.body ?? "{}")).toEqual({
      public_key: "p".repeat(32),
      secret_key: "s".repeat(32),
    });
    const prices = calls.filter((c) => c.url.includes("/orders/prices"));
    expect(prices[0]?.headers["authorization"]).toBe("Bearer tok-1");
  });

  it("chei respinse: eroare de autentificare, fără chei în mesaj", async () => {
    const f = fakeFetch({
      "POST /account/authorize": () => ({ status: 401, body: { error: "x" } }),
    });
    const carrier = new WootproCarrier({
      credentials: {
        publicKey: "PUBLICA-SECRETA",
        secretKey: "CHEIE-SECRETA",
        senderAddressId: "1",
      },
      mode: "test",
      fetch: f.fetchImpl,
    });
    const error = await carrier.quote({ parcels, destination, codAmountMinor: 0 }).catch((e) => e);
    expect(error).toMatchObject({ code: "SHIPPING_AUTH_FAILED" });
    expect(String(error.message)).not.toContain("CHEIE-SECRETA");
    expect(String(error.message)).not.toContain("PUBLICA-SECRETA");
  });

  it("testConnection: ok cu chei bune, nu ok cu chei greșite", async () => {
    expect((await make({}).carrier.testConnection()).ok).toBe(true);
    const f = fakeFetch({ "POST /account/authorize": () => ({ status: 401, body: {} }) });
    const bad = new WootproCarrier({
      credentials: { publicKey: "a", secretKey: "b", senderAddressId: "1" },
      mode: "test",
      fetch: f.fetchImpl,
    });
    expect((await bad.testConnection()).ok).toBe(false);
  });
});

describe("wootPRO: tarife în timp real", () => {
  it("trimite colete în kg și cm, ramburs ca număr, și citește tarifele în bani", async () => {
    const { carrier, calls } = make({
      "POST /orders/prices": () => ({
        body: [
          {
            service_id: 42,
            service_name: "Standard",
            service_delivery: "door",
            courier_name: "Fan Courier",
            total: 20.0,
            final_total: 23.8,
            errors: [],
          },
          {
            service_id: 43,
            service_name: "Locker",
            service_delivery: "location",
            courier_name: "Sameday",
            final_total: 14.99,
            errors: [],
          },
        ],
      }),
    });
    const quotes = await carrier.quote({ parcels, destination, codAmountMinor: 25_000 });
    expect(quotes).toEqual([
      expect.objectContaining({
        serviceCode: "42",
        courier: "Fan Courier",
        kind: "courier",
        priceMinor: 2380,
      }),
      expect.objectContaining({ serviceCode: "43", kind: "easybox", priceMinor: 1499 }),
    ]);
    const sent = JSON.parse(calls.find((c) => c.url.includes("/orders/prices"))?.body ?? "{}");
    expect(sent).toMatchObject({
      sender: { address_id: 77 },
      receiver: { city_id: 10, zipcode: "510005" },
      parcels: [{ type: "package", weight: 12.5, length: 30, width: 30, height: 20 }],
      repayment: 250,
    });
  });

  it("toate serviciile cu erori: refuz (cere paletizat sau rezervă), nu cădere", async () => {
    const { carrier } = make({
      "POST /orders/prices": () => ({
        body: [{ service_id: 1, final_total: 10, errors: ["Greutate peste limită"] }],
      }),
    });
    await expect(carrier.quote({ parcels, destination, codAmountMinor: 0 })).rejects.toMatchObject({
      code: "SHIPPING_REFUSED",
    });
  });

  it("localitate necunoscută în nomenclator: eroare tipizată", async () => {
    const { carrier } = make({});
    await expect(
      carrier.quote({
        parcels,
        destination: { ...destination, localityName: "Satul Inexistent" },
        codAmountMinor: 0,
      }),
    ).rejects.toMatchObject({ code: "SHIPPING_LOCATION_UNMAPPED" });
  });

  it("potrivirea numelor ignoră diacriticele și prefixele (Sebeș = Sebes, «Municipiul Alba Iulia»)", async () => {
    const { carrier } = make({ "POST /orders/prices": () => ({ body: [] }) });
    await carrier
      .quote({
        parcels,
        destination: { ...destination, localityName: "Municipiul Alba Iulia" },
        codAmountMinor: 0,
      })
      .catch((e) => expect(e.code).not.toBe("SHIPPING_LOCATION_UNMAPPED"));
    await carrier
      .quote({ parcels, destination: { ...destination, localityName: "SEBES" }, codAmountMinor: 0 })
      .catch((e) => expect(e.code).not.toBe("SHIPPING_LOCATION_UNMAPPED"));
  });
});

describe("wootPRO: AWB, etichetă, urmărire, anulare", () => {
  it("creează AWB cu rambursul transmis curierului și întoarce numărul și referința", async () => {
    const { carrier, calls } = make({
      "POST /orders": () => ({ body: { success: true, order_id: 9001, awb_number: "WP123456" } }),
    });
    const result = await carrier.createAwb(awbRequest);
    expect(result).toMatchObject({ awb: "WP123456", providerRef: "9001", parcelCount: 1 });
    const sent = JSON.parse(
      calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"))?.body ?? "{}",
    );
    expect(sent).toMatchObject({
      service_id: 42,
      repayment: 123.45,
      insurance: 123.45,
      payment_method: "credit",
      receiver: {
        name: "Ion Popescu",
        phone: "0722123456",
        city_id: 10,
        address: "Str. Exemplu 1",
      },
    });
  });

  it("fără ramburs, câmpul `repayment` nu se trimite", async () => {
    const { carrier, calls } = make({
      "POST /orders": () => ({ body: { success: true, order_id: 1, awb_number: "A1" } }),
    });
    await carrier.createAwb({ ...awbRequest, codAmountMinor: 0 });
    const sent = JSON.parse(
      calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"))?.body ?? "{}",
    );
    expect(sent).not.toHaveProperty("repayment");
  });

  it("eroarea curierului ajunge în mesaj, dar nu datele destinatarului", async () => {
    const { carrier } = make({
      "POST /orders": () => ({
        status: 400,
        body: { error: "Nu aveti suficient credit pentru a finaliza comanda" },
      }),
    });
    const error = await carrier.createAwb(awbRequest).catch((e) => e);
    expect(error).toMatchObject({ code: "SHIPPING_REJECTED" });
    expect(error.message).toContain("suficient credit");
    expect(error.message).not.toContain("Ion Popescu");
    expect(error.message).not.toContain("0722123456");
    expect(error.message).not.toContain("Str. Exemplu");
  });

  it("fără serviciu ales la checkout: refuzat înainte de orice apel", async () => {
    const { carrier, calls } = make({});
    await expect(carrier.createAwb({ ...awbRequest, serviceCode: null })).rejects.toMatchObject({
      code: "SHIPPING_REJECTED",
    });
    expect(calls).toHaveLength(0);
  });

  it("eticheta PDF vine în base64 și se decodifică; ZPL nu e oferit", async () => {
    const { carrier } = make({
      "GET /orders/9001/awb": () => ({
        body: { success: true, pdf: Buffer.from("%PDF-1.4 test").toString("base64") },
      }),
    });
    const label = await carrier.getLabel({ awb: "WP1", providerRef: "9001" }, "pdf");
    expect(label.format).toBe("pdf");
    expect(Buffer.from(label.bytes).toString()).toBe("%PDF-1.4 test");
    await expect(
      carrier.getLabel({ awb: "WP1", providerRef: "9001" }, "zpl"),
    ).rejects.toMatchObject({
      code: "SHIPPING_UNSUPPORTED",
    });
  });

  it("istoricul se transformă în evenimente cu chei stabile și stare normalizată", async () => {
    const history = [
      {
        id: 1,
        order_id: 9001,
        status_id: 1,
        comment: "Primită",
        hash: "h1",
        updated: "2030-01-01T10:00:00Z",
      },
      {
        id: 2,
        order_id: 9001,
        status_id: 3,
        comment: "Ridicată",
        hash: "h2",
        updated: "2030-01-01T12:00:00Z",
      },
      {
        id: 3,
        order_id: 9001,
        status_id: 10,
        comment: "Livrată",
        hash: "h3",
        updated: "2030-01-02T09:00:00Z",
      },
    ];
    const { carrier } = make({ "GET /orders/9001/history": () => ({ body: history }) });
    const first = await carrier.track({ awb: "WP1", providerRef: "9001" });
    const second = await carrier.track({ awb: "WP1", providerRef: "9001" });
    expect(first.status).toBe("delivered");
    expect(first.events.map((e) => [e.key, e.status])).toEqual([
      ["h1", "created"],
      ["h2", "picked_up"],
      ["h3", "delivered"],
    ]);
    expect(second.events.map((e) => e.key)).toEqual(first.events.map((e) => e.key));
  });

  it("anularea trimite DELETE cu un motiv; eroarea curierului se transmite", async () => {
    const { carrier, calls } = make({ "DELETE /orders/9001": () => ({ body: { success: true } }) });
    await carrier.cancel({ awb: "WP1", providerRef: "9001" });
    expect(JSON.parse(calls.find((c) => c.method === "DELETE")?.body ?? "{}")).toEqual({
      reason_id: 5,
    });
    const failing = make({
      "DELETE /orders/9001": () => ({
        status: 400,
        body: { error: "Comanda nu mai poate fi anulată" },
      }),
    });
    await expect(failing.carrier.cancel({ awb: "WP1", providerRef: "9001" })).rejects.toMatchObject(
      {
        code: "SHIPPING_REJECTED",
      },
    );
  });

  it("AWB de retur: nesuportat prin API (se introduce manual)", async () => {
    await expect(make({}).carrier.createReturnAwb()).rejects.toMatchObject({
      code: "SHIPPING_UNSUPPORTED",
    });
  });

  it("puncte de ridicare: filtrate pe județ și localitate", async () => {
    const { carrier } = make({
      "GET /general/locations": () => ({
        body: [
          { id: 5, name: "Locker 1", city: "Alba Iulia", county: "Alba", address: "Str. A" },
          { id: 6, name: "Locker 2", city: "Sebeș", county: "Alba", address: "Str. B" },
        ],
      }),
    });
    const points = await carrier.listPickupPoints({ countyName: "Alba", localityName: "Sebes" });
    expect(points.map((p) => p.id)).toEqual(["6"]);
  });
});

describe("wootPRO: stările", () => {
  it("codurile din specificație", () => {
    expect([0, 1, 2, 3, 10, 5].map(wootproStatus)).toEqual([
      "cancelled",
      "created",
      "created",
      "picked_up",
      "delivered",
      "in_transit",
    ]);
  });
});
