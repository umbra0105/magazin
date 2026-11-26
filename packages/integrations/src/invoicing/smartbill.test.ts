import { describe, expect, it } from "vitest";
import { IntegrationError, type InvoiceDocLine, type InvoiceRequest } from "@ecom/shared";
import {
  SMARTBILL_BASE_URL,
  SmartbillProvider,
  buildDocumentBody,
  type SmartbillCredentials,
} from "./smartbill";

/**
 * Teste de CONTRACT pe răspunsuri SIMULATE (fixture-uri scrise după specificația OpenAPI SmartBill, citită la 2026-11-22). Nu
 * dovedesc nimic despre API-ul real: adaptorul rămâne «încă netestat cu cont real». Niciun test nu contactează SmartBill.
 */
const CREDS: SmartbillCredentials = {
  email: "cont@exemplu.invalid",
  token: "token-de-test-fals",
  companyVatCode: "RO12345678",
  invoiceSeries: "FCT",
  proformaSeries: "PRF",
  taxName: "Normala",
  warehouseName: "Depozit principal",
};

const product = (over: Partial<InvoiceDocLine> = {}): InvoiceDocLine => ({
  kind: "product",
  name: "Mozaic piscină",
  code: "MZ-1",
  unitName: "mp",
  quantityTicks: 60_900n,
  unitPriceMinor: 12_345,
  lineTotalMinor: 75_181,
  taxMinor: 13_048,
  taxRateBps: 2100,
  dischargeStock: true,
  ...over,
});

const shipping: InvoiceDocLine = {
  kind: "shipping",
  name: "Transport",
  code: null,
  unitName: "buc",
  quantityTicks: 10_000n,
  unitPriceMinor: 3_500,
  lineTotalMinor: 3_500,
  taxMinor: 607,
  taxRateBps: 2100,
  dischargeStock: false,
};

const request = (over: Partial<InvoiceRequest> = {}): InvoiceRequest => ({
  orderNumber: "WEB-000123",
  client: {
    name: "Ion Popescu",
    vatCode: null,
    isTaxPayer: false,
    regCom: null,
    address: "Strada Exemplu 7",
    city: "Alba Iulia",
    county: "Alba",
    country: "Romania",
    email: "ion@exemplu.invalid",
    phone: "0722000000",
  },
  lines: [product(), shipping],
  currency: "RON",
  issueDate: new Date("2026-11-22T10:00:00Z"),
  useStock: true,
  payment: null,
  fromProforma: null,
  sendEmail: false,
  ...over,
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Reply = { status?: number; body: unknown; raw?: string };

function fakeFetch(routes: Record<string, (call: Call) => Reply>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
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
    const path = url.replace(SMARTBILL_BASE_URL, "").split("?")[0] ?? "";
    const route = routes[`${method} ${path}`];
    if (!route) return new Response("necunoscut", { status: 404 });
    const out = route(call);
    return new Response(out.raw ?? JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const issued = {
  errorText: "",
  message: "",
  number: "0042",
  series: "FCT",
  documentId: 777,
  documentViewUrl: "https://cloud.smartbill.invalid/view/abc",
};

const provider = (impl: (u: string, i: RequestInit) => Promise<Response>) =>
  new SmartbillProvider({ credentials: CREDS, fetch: impl });

describe("corpul facturii (după specificația SmartBill)", () => {
  it("trimite prețul CU TVA inclus, cantitatea cu 2 zecimale și cota ca procent", () => {
    const body = buildDocumentBody(request(), CREDS, "invoice") as {
      products: Array<Record<string, unknown>>;
    };
    expect(body.products[0]).toMatchObject({
      name: "Mozaic piscină",
      code: "MZ-1",
      measuringUnitName: "mp",
      quantity: 6.09,
      price: 123.45,
      isTaxIncluded: true,
      taxName: "Normala",
      taxPercentage: 21,
      isService: false,
      saveToDb: false,
    });
    expect(body.products[1]).toMatchObject({
      name: "Transport",
      isService: true,
      quantity: 1,
      price: 35,
    });
  });

  it("descărcarea de gestiune: o singură bifă, doar dacă TOATE produsele se descarcă și gestiunea e configurată", () => {
    const all = buildDocumentBody(request(), CREDS, "invoice") as {
      useStock: boolean;
      products: Array<Record<string, unknown>>;
    };
    expect(all.useStock).toBe(true);
    expect(all.products[0]?.["warehouseName"]).toBe("Depozit principal");
    expect(all.products[1]).not.toHaveProperty("warehouseName"); // serviciul nu cere gestiune (presupus)

    const mixed = buildDocumentBody(
      request({ lines: [product(), product({ code: "X", dischargeStock: false }), shipping] }),
      CREDS,
      "invoice",
    ) as { useStock: boolean; products: Array<Record<string, unknown>> };
    expect(mixed.useStock).toBe(false);
    expect(mixed.products.some((p) => "warehouseName" in p)).toBe(false);

    const noWarehouse = buildDocumentBody(
      request(),
      { ...CREDS, warehouseName: "" },
      "invoice",
    ) as {
      useStock: boolean;
    };
    expect(noWarehouse.useStock).toBe(false);

    const wanted = buildDocumentBody(request({ useStock: false }), CREDS, "invoice") as {
      useStock: boolean;
    };
    expect(wanted.useStock).toBe(false);
  });

  it("proforma folosește seria de proforme și nu are descărcare, plată sau proformă-sursă", () => {
    const body = buildDocumentBody(
      request({ payment: { type: "Card online", valueMinor: 100 } }),
      CREDS,
      "proforma",
    );
    expect(body["seriesName"]).toBe("PRF");
    expect(body).not.toHaveProperty("useStock");
    expect(body).not.toHaveProperty("payment");
  });

  it("încasarea și proforma-sursă se trec pe factură", () => {
    const body = buildDocumentBody(
      request({
        payment: { type: "Card online", valueMinor: 78_681 },
        fromProforma: { series: "PRF", number: "0007" },
      }),
      CREDS,
      "invoice",
    );
    expect(body["payment"]).toEqual({ value: 786.81, type: "Card online", isCash: false });
    expect(body["useEstimateDetails"]).toBe(true);
    expect(body["estimate"]).toEqual({ seriesName: "PRF", number: "0007" });
  });

  it("trimite email prin furnizor doar dacă setarea o cere și clientul are adresă", () => {
    const on = buildDocumentBody(request({ sendEmail: true }), CREDS, "invoice");
    expect(on["sendEmail"]).toBe(true);
    expect(on["email"]).toEqual({ to: "ion@exemplu.invalid" });
    const off = buildDocumentBody(request(), CREDS, "invoice");
    expect(off["sendEmail"]).toBe(false);
    expect(off).not.toHaveProperty("email");
  });

  it("cantități negative la stornoul parțial, cu 2 zecimale", () => {
    const body = buildDocumentBody(
      request({
        lines: [product({ quantityTicks: -10_000n, lineTotalMinor: -12_345, taxMinor: -2_142 })],
      }),
      CREDS,
      "invoice",
    ) as { products: Array<Record<string, unknown>> };
    expect(body.products[0]?.["quantity"]).toBe(-1);
  });

  it("o cantitate cu mai mult de 2 zecimale se refuză, nu se rotunjește în tăcere", () => {
    expect(() =>
      buildDocumentBody(
        request({ lines: [product({ quantityTicks: 60_901n })] }),
        CREDS,
        "invoice",
      ),
    ).toThrowError(/2 zecimale/);
  });

  it("data documentului e data calendaristică din România", () => {
    const late = buildDocumentBody(
      request({ issueDate: new Date("2026-11-22T22:30:00Z") }),
      CREDS,
      "invoice",
    );
    expect(late["issueDate"]).toBe("2026-11-23"); // 00:30 la București (EET)
  });
});

describe("emiterea facturii", () => {
  it("autentificare Basic, apel pe /invoice/v2, apoi citește totalul din /invoice/paymentstatus", async () => {
    const f = fakeFetch({
      "POST /invoice/v2": () => ({ body: issued }),
      "GET /invoice/paymentstatus": () => ({
        body: {
          errorText: "",
          invoiceTotalAmount: 786.81,
          paidAmount: 0,
          unpaidAmount: 786.81,
          paid: false,
        },
      }),
    });
    const doc = await provider(f.impl).issueInvoice(request());
    expect(doc).toMatchObject({
      series: "FCT",
      number: "0042",
      providerRef: "777",
      simulated: false,
      efacturaStatus: "unknown",
      totalMinor: 78_681,
      taxMinor: null,
    });
    const first = f.calls[0];
    expect(first?.headers["authorization"]).toBe(
      `Basic ${Buffer.from("cont@exemplu.invalid:token-de-test-fals").toString("base64")}`,
    );
    expect(first?.url).toBe(`${SMARTBILL_BASE_URL}/invoice/v2`);
    expect(JSON.parse(first?.body ?? "{}")).toMatchObject({
      companyVatCode: "RO12345678",
      seriesName: "FCT",
      observations: "Comanda WEB-000123",
    });
    const status = f.calls[1];
    expect(status?.url).toContain("cif=RO12345678");
    expect(status?.url).toContain("seriesname=FCT");
    expect(status?.url).toContain("number=0042");
  });

  it("dacă citirea totalului eșuează, documentul rămâne emis, cu totalul necunoscut", async () => {
    const f = fakeFetch({
      "POST /invoice/v2": () => ({ body: issued }),
      "GET /invoice/paymentstatus": () => ({ status: 500, body: "<html>eroare</html>" }),
    });
    const doc = await provider(f.impl).issueInvoice(request());
    expect(doc.number).toBe("0042");
    expect(doc.totalMinor).toBeNull();
  });

  it("proforma: /estimate/v2, fără e-Factura", async () => {
    const f = fakeFetch({
      "POST /estimate/v2": () => ({ body: { ...issued, series: "PRF", number: "0007" } }),
    });
    const doc = await provider(f.impl).issueProforma(request());
    expect(doc).toMatchObject({ series: "PRF", number: "0007", efacturaStatus: "not_applicable" });
  });

  it("errorText completat chiar cu HTTP 200 = refuz, fără datele clientului în mesaj", async () => {
    const f = fakeFetch({
      "POST /invoice/v2": () => ({
        body: { errorText: "Seria nu a fost gasita!", number: "", series: "" },
      }),
    });
    const error = await provider(f.impl)
      .issueInvoice(request())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe("INVOICE_REJECTED");
    expect((error as Error).message).toContain("Seria nu a fost gasita");
    expect((error as Error).message).not.toContain("Ion Popescu");
    expect((error as Error).message).not.toContain("Strada Exemplu");
  });

  it("răspuns de succes fără serie și număr = răspuns neinterpretabil (rezultat nesigur)", async () => {
    const f = fakeFetch({ "POST /invoice/v2": () => ({ body: { errorText: "" } }) });
    const error = await provider(f.impl)
      .issueInvoice(request())
      .catch((e: unknown) => e);
    expect((error as IntegrationError).code).toBe("INVOICE_BAD_RESPONSE");
  });

  const cases: Array<[string, Reply, string]> = [
    ["401", { status: 401, body: { errorText: "Autentificare esuata." } }, "INVOICE_AUTH_FAILED"],
    ["429", { status: 429, body: { message: "limit" } }, "INVOICE_RATE_LIMITED"],
    [
      "400 cu errorText",
      { status: 400, body: { errorText: "Clientul este obligatoriu" } },
      "INVOICE_REJECTED",
    ],
    [
      "410 limita abonamentului",
      { status: 410, body: { errorText: "Pentru acest pachet s-a emis numarul maxim" } },
      "INVOICE_REJECTED",
    ],
    [
      "400 camp necunoscut",
      {
        status: 400,
        body: {
          type: "invalid_request_error",
          errors: [{ code: "json_mapping_error", param: "Price" }],
        },
      },
      "INVOICE_REJECTED",
    ],
    ["500 HTML", { status: 500, body: "x", raw: "<html>eroare</html>" }, "INVOICE_BAD_RESPONSE"],
  ];
  for (const [name, reply, code] of cases) {
    it(`HTTP ${name} → ${code}`, async () => {
      const f = fakeFetch({ "POST /invoice/v2": () => reply });
      const error = await provider(f.impl)
        .issueInvoice(request())
        .catch((e: unknown) => e);
      expect((error as IntegrationError).code).toBe(code);
    });
  }

  it("timp depășit → rezultat nesigur (TIMEOUT); conexiune refuzată → sigur de reîncercat (UNREACHABLE)", async () => {
    const timeout = async (): Promise<Response> => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      throw e;
    };
    const refused = async (): Promise<Response> => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    };
    const reset = async (): Promise<Response> => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    };
    expect(
      (
        (await provider(timeout)
          .issueInvoice(request())
          .catch((e: unknown) => e)) as IntegrationError
      ).code,
    ).toBe("INVOICE_PROVIDER_TIMEOUT");
    expect(
      (
        (await provider(refused)
          .issueInvoice(request())
          .catch((e: unknown) => e)) as IntegrationError
      ).code,
    ).toBe("INVOICE_PROVIDER_UNREACHABLE");
    expect(
      (
        (await provider(reset)
          .issueInvoice(request())
          .catch((e: unknown) => e)) as IntegrationError
      ).code,
    ).toBe("INVOICE_PROVIDER_TIMEOUT");
  });

  it("configurare incompletă: refuz înainte de orice apel", async () => {
    const f = fakeFetch({});
    const p = new SmartbillProvider({
      credentials: { ...CREDS, invoiceSeries: "" },
      fetch: f.impl,
    });
    const error = await p.issueInvoice(request()).catch((e: unknown) => e);
    expect((error as IntegrationError).code).toBe("INVOICE_NOT_CONFIGURED");
    expect(f.calls).toHaveLength(0);
  });
});

describe("storno, anulare, PDF, e-Factura, conexiune", () => {
  it("storno total: /invoice/reverse cu seria și numărul facturii originale", async () => {
    const f = fakeFetch({
      "POST /invoice/reverse": () => ({ body: { ...issued, number: "0043", documentId: "778" } }),
    });
    const doc = await provider(f.impl).reverseInvoice(
      { series: "FCT", number: "0042" },
      new Date("2026-11-22T10:00:00Z"),
    );
    expect(doc).toMatchObject({ number: "0043", providerRef: "778" });
    expect(JSON.parse(f.calls[0]?.body ?? "{}")).toEqual({
      companyVatCode: "RO12345678",
      seriesName: "FCT",
      number: "0042",
      issueDate: "2026-11-22",
    });
  });

  it("«factura este deja stornată» = refuz funcțional", async () => {
    const f = fakeFetch({
      "POST /invoice/reverse": () => ({
        status: 400,
        body: { errorText: "Factura este deja stornata." },
      }),
    });
    const error = await provider(f.impl)
      .reverseInvoice({ series: "FCT", number: "0042" }, new Date())
      .catch((e: unknown) => e);
    expect((error as IntegrationError).code).toBe("INVOICE_REJECTED");
  });

  it("anulare proformă: PUT /estimate/cancel", async () => {
    const f = fakeFetch({
      "PUT /estimate/cancel": () => ({ body: { errorText: "", message: "ok" } }),
    });
    await provider(f.impl).cancelProforma({ series: "PRF", number: "0007" });
    expect(f.calls[0]?.method).toBe("PUT");
    expect(f.calls[0]?.url).toContain("seriesname=PRF");
  });

  it("PDF: nu trimite «Accept: application/pdf»; un răspuns care nu e PDF e respins", async () => {
    const pdf = "%PDF-1.4\nfals\n%%EOF";
    const f = fakeFetch({
      "GET /invoice/pdf": () => ({ body: null, raw: pdf }),
      "GET /estimate/pdf": () => ({ status: 502, body: null, raw: "<html>Bad Gateway</html>" }),
    });
    const p = provider(f.impl);
    const out = await p.getInvoicePdf({ series: "FCT", number: "0042" });
    expect(out.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(out.bytes).startsWith("%PDF")).toBe(true);
    expect(f.calls[0]?.headers["accept"]).toBe("*/*");
    const error = await p.getProformaPdf({ series: "PRF", number: "1" }).catch((e: unknown) => e);
    expect((error as IntegrationError).code).toBe("INVOICE_REJECTED");
  });

  it("e-Factura: API-ul nu expune statusul → «unknown» și furnizorul spune că nu îl raportează", async () => {
    const p = provider(fakeFetch({}).impl);
    expect(p.reportsEfactura).toBe(false);
    expect(await p.getEfacturaStatus()).toBe("unknown");
  });

  it("testul de conexiune citește seriile de facturi și verifică seria configurată", async () => {
    const f = fakeFetch({
      "GET /series": () => ({
        body: { errorText: "", list: [{ name: "FCT", nextNumber: 43, type: "f" }] },
      }),
    });
    const ok = await provider(f.impl).testConnection();
    expect(ok.ok).toBe(true);
    expect(f.calls[0]?.url).toContain("type=f");
    const missing = await new SmartbillProvider({
      credentials: { ...CREDS, invoiceSeries: "ALTA" },
      fetch: f.impl,
    }).testConnection();
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("nu există în cont");
    const bad = await provider(
      fakeFetch({ "GET /series": () => ({ status: 401, body: {} }) }).impl,
    ).testConnection();
    expect(bad.ok).toBe(false);
  });
});

describe("descărcarea de gestiune raportată de adaptor", () => {
  it("true doar dacă s-a trimis useStock (toate produsele se descarcă ȘI gestiunea e configurată)", async () => {
    const f = fakeFetch({
      "POST /invoice/v2": () => ({ body: issued }),
      "GET /invoice/paymentstatus": () => ({ body: { errorText: "", invoiceTotalAmount: 786.81 } }),
    });
    expect((await provider(f.impl).issueInvoice(request())).stockDischarged).toBe(true);
    // fără gestiune configurată: factura iese fără descărcare, iar adaptorul o spune
    const noWarehouse = new SmartbillProvider({
      credentials: { ...CREDS, warehouseName: "" },
      fetch: f.impl,
    });
    expect((await noWarehouse.issueInvoice(request())).stockDischarged).toBe(false);
    // un produs care nu se descarcă: întreaga factură fără descărcare
    const mixed = request({
      lines: [product(), product({ code: "X", dischargeStock: false }), shipping],
    });
    expect((await provider(f.impl).issueInvoice(mixed)).stockDischarged).toBe(false);
    // proforma și stornoul nu descarcă niciodată
    const g = fakeFetch({
      "POST /estimate/v2": () => ({ body: issued }),
      "POST /invoice/reverse": () => ({ body: issued }),
    });
    expect((await provider(g.impl).issueProforma(request())).stockDischarged).toBe(false);
    expect(
      (await provider(g.impl).reverseInvoice({ series: "FCT", number: "1" }, new Date()))
        .stockDischarged,
    ).toBe(false);
  });
});

describe("rândul de reducere din puncte (Faza 15b; reprezentare PRESUPUSĂ, nedocumentată: de verificat în sandbox)", () => {
  const discount: InvoiceDocLine = {
    kind: "discount",
    name: "Reducere din puncte de loialitate: Mozaic piscină",
    code: null,
    unitName: "buc",
    quantityTicks: -10_000n,
    unitPriceMinor: 3_333,
    lineTotalMinor: -3_333,
    taxMinor: -578,
    taxRateBps: 2100,
    dischargeStock: false,
  };

  it("pleacă drept serviciu cu cantitate negativă, preț pozitiv și aceeași cotă, fără gestiune", () => {
    const body = buildDocumentBody(
      {
        orderNumber: "T-1",
        client: {
          name: "Ion Popescu",
          vatCode: null,
          isTaxPayer: false,
          regCom: null,
          address: "Str. 1",
          city: "Alba Iulia",
          county: "Alba",
          country: "Romania",
          email: null,
          phone: null,
        },
        lines: [product(), discount, shipping],
        currency: "RON",
        issueDate: new Date(),
        useStock: true,
        payment: null,
        fromProforma: null,
        sendEmail: false,
      },
      CREDS,
      "invoice",
    );
    const products = body["products"] as Array<Record<string, unknown>>;
    expect(products[1]).toMatchObject({
      name: discount.name,
      isService: true,
      quantity: -1,
      price: 33.33,
      isTaxIncluded: true,
      taxPercentage: 21,
    });
    expect(products[1]).not.toHaveProperty("warehouseName");
    // reducerea nu strică descărcarea de gestiune a produselor
    expect(body["useStock"]).toBe(true);
  });
});
