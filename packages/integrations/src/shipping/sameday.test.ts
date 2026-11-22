import { describe, expect, it } from "vitest";
import type { CarrierAwbRequest } from "@ecom/shared";
import { encodeForm, SamedayCarrier, samedayStatus, SAMEDAY_DEMO_URL } from "./sameday";

/**
 * Teste de CONTRACT pe răspunsuri SIMULATE. Căile și forma răspunsurilor în afara autentificării sunt PRESUPUSE (documentația
 * oficială nu a putut fi citită, vezi `sameday.ts`): testele fixează aceste presupuneri, nu dovedesc API-ul real.
 */
interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(
  routes: Record<string, (call: Call) => { status?: number; body: unknown; raw?: Uint8Array }>,
) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const method = String(init.method ?? "GET");
    const path = url.replace(SAMEDAY_DEMO_URL, "").split("?")[0] ?? "";
    const call: Call = {
      method,
      path,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (!route) return new Response("{}", { status: 404 });
    const out = route(call);
    const payload = out.raw ?? JSON.stringify(out.body);
    return new Response(payload as string | Uint8Array<ArrayBuffer>, { status: out.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const AUTH = {
  "POST /api/authenticate": () => ({ body: { token: "T1", expire_at: "2030-01-01 23:00" } }),
};
const COUNTY = {
  "GET /api/geolocation/county": () => ({ body: { data: [{ id: 1, name: "Alba" }] } }),
};
const CITY = {
  "GET /api/geolocation/city": () => ({
    body: {
      data: [
        { id: 100, name: "Alba Iulia" },
        { id: 101, name: "Sebeș" },
      ],
    },
  }),
};

const make = (routes: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch({ ...AUTH, ...COUNTY, ...CITY, ...routes });
  const carrier = new SamedayCarrier({
    credentials: {
      username: "utilizator-test",
      password: "PAROLA-SECRETA",
      pickupPointId: "5",
      defaultServiceId: "7",
    },
    mode: "test",
    fetch: f.fetchImpl,
    now: () => new Date("2030-01-01T10:00:00Z"),
  });
  return { carrier, calls: f.calls };
};

const destination = { countyName: "Alba", localityName: "Alba Iulia", postalCode: "510005" };
const parcels = [{ weightGrams: 2_500, lengthMm: 200, widthMm: 150, heightMm: 100 }];
const awbRequest: CarrierAwbRequest = {
  reference: "WEB-0002",
  recipient: { ...destination, name: "Maria Ionescu", phone: "0733111222", street: "Str. Test 5" },
  parcels,
  codAmountMinor: 9_990,
  declaredValueMinor: 9_990,
};

describe("Sameday: autentificare", () => {
  it("trimite utilizatorul și parola în antete, apoi tokenul în X-AUTH-TOKEN; tokenul se reutilizează", async () => {
    const { carrier, calls } = make({
      "POST /api/awb/estimation": () => ({ body: { amount: 18.5 } }),
    });
    await carrier.quote({ parcels, destination, codAmountMinor: 0 });
    await carrier.quote({ parcels, destination, codAmountMinor: 0 });
    const auth = calls.filter((c) => c.path === "/api/authenticate");
    expect(auth).toHaveLength(1);
    expect(auth[0]?.headers["x-auth-username"]).toBe("utilizator-test");
    expect(auth[0]?.body).toBe("remember_me=true");
    expect(calls.find((c) => c.path === "/api/awb/estimation")?.headers["x-auth-token"]).toBe("T1");
  });

  it("un 401 pe un apel autentificat: reautentificare și o singură reîncercare", async () => {
    let first = true;
    const { carrier, calls } = make({
      "GET /api/geolocation/county": () => {
        if (first) {
          first = false;
          return { status: 401, body: {} };
        }
        return { body: { data: [{ id: 1, name: "Alba" }] } };
      },
      "POST /api/awb/estimation": () => ({ body: { amount: 10 } }),
    });
    await carrier.quote({ parcels, destination, codAmountMinor: 0 });
    expect(calls.filter((c) => c.path === "/api/authenticate")).toHaveLength(2);
  });

  it("date de acces respinse: eroare fără parolă în mesaj", async () => {
    const f = fakeFetch({ "POST /api/authenticate": () => ({ status: 401, body: {} }) });
    const carrier = new SamedayCarrier({
      credentials: {
        username: "u",
        password: "PAROLA-SECRETA",
        pickupPointId: "1",
        defaultServiceId: "1",
      },
      mode: "test",
      fetch: f.fetchImpl,
    });
    const error = await carrier.testConnection();
    expect(error.ok).toBe(false);
    expect(error.message).not.toContain("PAROLA-SECRETA");
  });
});

describe("Sameday: tarif, AWB, etichetă, urmărire, anulare", () => {
  it("tariful vine ca sumă în lei și se citește în bani; ramburs transmis ca sumă", async () => {
    const { carrier, calls } = make({
      "POST /api/awb/estimation": () => ({ body: { amount: 18.5 } }),
    });
    const quotes = await carrier.quote({ parcels, destination, codAmountMinor: 9_990 });
    expect(quotes).toEqual([
      expect.objectContaining({ serviceCode: "7", priceMinor: 1850, kind: "courier" }),
    ]);
    const body = decodeURIComponent(
      calls.find((c) => c.path === "/api/awb/estimation")?.body ?? "",
    );
    expect(body).toContain("cashOnDelivery=99.9");
    expect(body).toContain("awbRecipient[county]=1");
    expect(body).toContain("awbRecipient[city]=100");
    expect(body).toContain("parcels[0][weight]=2.5");
  });

  it("estimarea refuzată (400): refuz, nu cădere", async () => {
    const { carrier } = make({
      "POST /api/awb/estimation": () => ({ status: 400, body: { message: "Greutate" } }),
    });
    await expect(carrier.quote({ parcels, destination, codAmountMinor: 0 })).rejects.toMatchObject({
      code: "SHIPPING_REFUSED",
    });
  });

  it("AWB: formular cu rambursul și destinatarul; întoarce numărul AWB", async () => {
    const { carrier, calls } = make({
      "POST /api/awb": () => ({ body: { awbNumber: "1SAM0001" } }),
    });
    const result = await carrier.createAwb(awbRequest);
    expect(result).toMatchObject({ awb: "1SAM0001", providerRef: "1SAM0001", parcelCount: 1 });
    const body = decodeURIComponent(calls.find((c) => c.path === "/api/awb")?.body ?? "");
    expect(body).toContain("cashOnDelivery=99.9");
    expect(body).toContain("awbRecipient[name]=Maria Ionescu");
    expect(body).toContain("awbRecipient[phoneNumber]=0733111222");
    expect(body).toContain("clientInternalReference=WEB-0002");
    expect(body).toContain("awbPayment=1");
  });

  it("eroarea AWB nu poartă datele destinatarului", async () => {
    const { carrier } = make({
      "POST /api/awb": () => ({ status: 400, body: { message: "Serviciu invalid" } }),
    });
    const error = await carrier.createAwb(awbRequest).catch((e) => e);
    expect(error.code).toBe("SHIPPING_REJECTED");
    expect(error.message).not.toContain("Maria");
    expect(error.message).not.toContain("0733111222");
  });

  it("eticheta PDF vine binară și se păstrează octet cu octet; ZPL nu e oferit", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x80]);
    const { carrier } = make({
      "GET /api/awb/download/1SAM0001/A6": () => ({ body: null, raw: pdf }),
    });
    const label = await carrier.getLabel({ awb: "1SAM0001", providerRef: null }, "pdf");
    expect(Array.from(label.bytes)).toEqual(Array.from(pdf));
    await expect(
      carrier.getLabel({ awb: "1SAM0001", providerRef: null }, "zpl"),
    ).rejects.toMatchObject({
      code: "SHIPPING_UNSUPPORTED",
    });
  });

  it("istoricul: stări normalizate după etichetă, chei stabile", async () => {
    const { carrier } = make({
      "GET /api/client/parcel/1SAM0001/status-history": () => ({
        body: {
          expeditionHistory: [
            { statusId: 1, statusLabel: "AWB creat", statusDate: "2030-01-01T09:00:00Z" },
            {
              statusId: 2,
              statusLabel: "Colet preluat de la expeditor",
              statusDate: "2030-01-01T11:00:00Z",
            },
            { statusId: 9, statusLabel: "Livrat", statusDate: "2030-01-02T10:00:00Z" },
          ],
        },
      }),
    });
    const tracking = await carrier.track({ awb: "1SAM0001", providerRef: null });
    expect(tracking.status).toBe("delivered");
    expect(tracking.events.map((e) => e.status)).toEqual(["created", "picked_up", "delivered"]);
    expect(new Set(tracking.events.map((e) => e.key)).size).toBe(3);
  });

  it("anulare: DELETE pe numărul AWB", async () => {
    const { carrier, calls } = make({
      "DELETE /api/awb/1SAM0001": () => ({ body: {} }),
    });
    await carrier.cancel({ awb: "1SAM0001", providerRef: null });
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/awb/1SAM0001")).toBe(true);
  });

  it("easybox: lista se filtrează pe județ și localitate", async () => {
    const { carrier } = make({
      "GET /api/client/lockers": () => ({
        body: {
          data: [
            { lockerId: 1, name: "L1", county: "Alba", city: "Alba Iulia", address: "A" },
            { lockerId: 2, name: "L2", county: "Cluj", city: "Cluj-Napoca", address: "B" },
          ],
        },
      }),
    });
    const points = await carrier.listPickupPoints({ countyName: "Alba" });
    expect(points.map((p) => p.id)).toEqual(["1"]);
  });
});

describe("Sameday: ajutoare", () => {
  it("formularul cu chei imbricate", () => {
    expect(decodeURIComponent(encodeForm({ a: 1, b: { c: "x y" }, d: [{ e: 2 }], f: null }))).toBe(
      "a=1&b[c]=x y&d[0][e]=2",
    );
  });
  it("stările după etichetă", () => {
    expect(samedayStatus("Livrat")).toBe("delivered");
    expect(samedayStatus("Nelivrat, adresă greșită")).not.toBe("delivered");
    expect(samedayStatus("Retur către expeditor")).toBe("returned");
    expect(samedayStatus("În depozit")).toBe("in_transit");
  });
});
