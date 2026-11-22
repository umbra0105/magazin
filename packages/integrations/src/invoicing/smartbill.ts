import {
  IntegrationError,
  type ConnectionTestResult,
  type DocumentRef,
  type EfacturaStatus,
  type InvoiceDocLine,
  type InvoicePdf,
  type InvoiceProvider,
  type InvoiceRequest,
  type IssuedDocument,
} from "@ecom/shared";
import {
  bucharestDate,
  callInvoiceProvider,
  isRecord,
  minorToDecimal,
  safeSnippet,
  ticksToDecimal,
  type FetchLike,
  type InvoiceCall,
} from "./http";

/**
 * Adaptorul SmartBill Cloud (API V1), Faza 13. ÎNCĂ NETESTAT CU UN CONT REAL: construit după specificația OpenAPI publică
 * (`https://api.smartbill.ro/smartbill-api-spec.yaml`, «Ultima actualizare: 16 octombrie 2026», citită la 2026-11-22) și verificat
 * doar cu răspunsuri SIMULATE. Presupunerile care nu sunt în specificație sunt marcate «PRESUPUS» și trecute în FINISAJE.
 *
 * Ce spune specificația (și ce face adaptorul):
 *  - autentificare Basic (email + token API din Integrări); baza `https://ws.smartbill.ro/SBORO/api`; 30 de apeluri la 10 secunde
 *    per token (depășirea blochează accesul 10 minute: emiterea trece printr-o coadă cu un singur lucrător);
 *  - succesul unui apel V1 = `errorText` GOL (codul HTTP nu e suficient);
 *  - prețurile se trimit CU TVA inclus (`isTaxIncluded: true`), cantitatea cu 2 zecimale, seria/TVA/unitatea exact ca în cont;
 *  - `useStock` e o singură bifă pe factură și cere `warehouseName` pe FIECARE produs: adaptorul o trimite doar când toate
 *    liniile de produs se descarcă, altfel emite fără descărcare;
 *  - stornoul prin API (`/invoice/reverse`) e TOTAL (serie + număr); nu există storno parțial prin API;
 *  - NU există endpoint pentru statusul sau retrimiterea e-Factura: `getEfacturaStatus` întoarce `unknown`;
 *  - PDF-ul se cere fără `Accept: application/pdf` (răspunde 406); lipsa documentului dă 502 cu HTML.
 *
 * PRESUPUS (nedocumentat): stornoul PARȚIAL se emite ca factură cu cantități NEGATIVE (specificația spune că cantitățile
 * negative sunt acceptate); liniile de servicii (transport, taxă de ramburs) nu cer gestiune; o factură emisă din proformă
 * (`useEstimateDetails`) păstrează liniile trimise.
 */
export const SMARTBILL_BASE_URL = "https://ws.smartbill.ro/SBORO/api";

export interface SmartbillCredentials {
  email: string;
  token: string;
  /** CIF-ul firmei, exact ca în SmartBill Cloud. */
  companyVatCode: string;
  invoiceSeries: string;
  proformaSeries: string;
  /** Numele cotei TVA din cont (ex. «Normala»). */
  taxName: string;
  /** Gestiunea pentru descărcare; goală = niciodată descărcare. */
  warehouseName: string;
}

export interface SmartbillOptions {
  credentials: SmartbillCredentials;
  baseUrl?: string;
  fetch?: FetchLike;
}

const isOk = (json: unknown): json is Record<string, unknown> =>
  isRecord(json) && (json["errorText"] === undefined || json["errorText"] === "");

function bpsToPercent(bps: number): number {
  return bps / 100;
}

export function buildClientBody(request: InvoiceRequest): Record<string, unknown> {
  const c = request.client;
  return {
    name: c.name,
    ...(c.vatCode ? { vatCode: c.vatCode } : {}),
    isTaxPayer: c.isTaxPayer,
    ...(c.regCom ? { regCom: c.regCom } : {}),
    address: c.address,
    city: c.city,
    county: c.county,
    country: c.country,
    ...(c.email ? { email: c.email } : {}),
    ...(c.phone ? { phone: c.phone } : {}),
    saveToDb: false,
  };
}

function productBody(
  line: InvoiceDocLine,
  creds: SmartbillCredentials,
  useStock: boolean,
): Record<string, unknown> {
  const isService = line.kind !== "product";
  return {
    name: line.name,
    ...(line.code ? { code: line.code } : {}),
    isService,
    quantity: ticksToDecimal(line.quantityTicks),
    measuringUnitName: line.unitName,
    price: minorToDecimal(line.unitPriceMinor),
    isTaxIncluded: true,
    taxName: creds.taxName,
    taxPercentage: bpsToPercent(line.taxRateBps),
    saveToDb: false,
    ...(useStock && !isService && line.dischargeStock
      ? { warehouseName: creds.warehouseName }
      : {}),
  };
}

/** Corpul cererii de factură sau de proformă (exportat pentru teste). Fără stoc când gestiunea nu e configurată. */
export function buildDocumentBody(
  request: InvoiceRequest,
  creds: SmartbillCredentials,
  kind: "invoice" | "proforma",
): Record<string, unknown> {
  const useStock =
    kind === "invoice" &&
    request.useStock &&
    creds.warehouseName !== "" &&
    request.lines.filter((l) => l.kind === "product").every((l) => l.dischargeStock);
  const body: Record<string, unknown> = {
    companyVatCode: creds.companyVatCode,
    seriesName: kind === "invoice" ? creds.invoiceSeries : creds.proformaSeries,
    client: buildClientBody(request),
    issueDate: bucharestDate(request.issueDate),
    isDraft: false,
    language: "RO",
    currency: request.currency,
    precision: 2,
    observations: `Comanda ${request.orderNumber}`,
    products: request.lines.map((line) => productBody(line, creds, useStock)),
    sendEmail: request.sendEmail && request.client.email !== null,
    ...(request.sendEmail && request.client.email ? { email: { to: request.client.email } } : {}),
  };
  if (kind === "invoice") {
    body["useStock"] = useStock;
    if (request.payment && request.payment.valueMinor > 0) {
      body["payment"] = {
        value: minorToDecimal(request.payment.valueMinor),
        type: request.payment.type,
        isCash: false,
      };
      body["paymentDate"] = bucharestDate(request.issueDate);
    }
    if (request.fromProforma) {
      body["useEstimateDetails"] = true;
      body["estimate"] = {
        seriesName: request.fromProforma.series,
        number: request.fromProforma.number,
      };
    }
  }
  return body;
}

export class SmartbillProvider implements InvoiceProvider {
  readonly code = "smartbill" as const;
  readonly label = "SmartBill";
  readonly simulated = false;
  readonly reportsEfactura = false;
  private readonly base: string;

  constructor(private readonly options: SmartbillOptions) {
    this.base = options.baseUrl ?? SMARTBILL_BASE_URL;
  }

  private get creds(): SmartbillCredentials {
    return this.options.credentials;
  }

  private headers(json: boolean): Record<string, string> {
    const { email, token } = this.creds;
    return {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private assertConfigured(kind: "invoice" | "proforma" | "any"): void {
    const c = this.creds;
    const missing =
      !c.email ||
      !c.token ||
      !c.companyVatCode ||
      (kind === "invoice" && !c.invoiceSeries) ||
      (kind === "proforma" && !c.proformaSeries) ||
      ((kind === "invoice" || kind === "proforma") && !c.taxName);
    if (missing) {
      throw new IntegrationError(
        "INVOICE_NOT_CONFIGURED",
        "SmartBill nu e configurat complet (cont, CIF, serie, cotă TVA)",
      );
    }
  }

  /** Transformă un răspuns care nu e succes într-o eroare tipată, fără corpul cererii sau al răspunsului. */
  private fail(call: InvoiceCall): never {
    if (call.status === 401 || call.status === 403) {
      throw new IntegrationError("INVOICE_AUTH_FAILED", "SmartBill a refuzat autentificarea");
    }
    if (call.status === 429) {
      throw new IntegrationError(
        "INVOICE_RATE_LIMITED",
        "SmartBill: prea multe apeluri; accesul se reia după un timp",
      );
    }
    if (
      isRecord(call.json) &&
      typeof call.json["errorText"] === "string" &&
      call.json["errorText"]
    ) {
      // 400, 410 sau 200 cu errorText: refuz funcțional (serie, TVA, unitate, stoc, limită de abonament)
      throw new IntegrationError(
        "INVOICE_REJECTED",
        `SmartBill a refuzat documentul: ${safeSnippet(call.json["errorText"], 180)}`,
      );
    }
    if (call.status >= 400 && call.status < 500 && isRecord(call.json)) {
      throw new IntegrationError(
        "INVOICE_REJECTED",
        "SmartBill a refuzat cererea (câmp necunoscut sau invalid)",
      );
    }
    throw new IntegrationError("INVOICE_BAD_RESPONSE", "Răspuns neașteptat de la SmartBill");
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const call = await callInvoiceProvider(this.options.fetch, `${this.base}${path}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!call.ok || !isOk(call.json)) this.fail(call);
    return call.json as Record<string, unknown>;
  }

  private documentFrom(
    json: Record<string, unknown>,
    efacturaStatus: EfacturaStatus,
    stockDischarged = false,
  ): IssuedDocument {
    const series = json["series"];
    const number = json["number"];
    const id = json["documentId"];
    if (
      typeof series !== "string" ||
      series === "" ||
      (typeof number !== "string" && typeof number !== "number") ||
      String(number) === ""
    ) {
      throw new IntegrationError(
        "INVOICE_BAD_RESPONSE",
        "SmartBill nu a întors seria și numărul documentului",
      );
    }
    const view = json["documentViewUrl"];
    return {
      series,
      number: String(number),
      providerRef:
        typeof id === "number" || typeof id === "string" ? String(id) : `${series}${number}`,
      viewUrl: typeof view === "string" && view !== "" ? view : null,
      simulated: false,
      efacturaStatus,
      stockDischarged,
      totalMinor: null,
      taxMinor: null,
    };
  }

  /** Totalul facturii după cum îl vede SmartBill (singurul total pe care API-ul îl expune), în bani; `null` dacă nu se poate citi. */
  private async readTotal(doc: DocumentRef): Promise<number | null> {
    try {
      const params = new URLSearchParams({
        cif: this.creds.companyVatCode,
        seriesname: doc.series,
        number: doc.number,
      });
      const call = await callInvoiceProvider(
        this.options.fetch,
        `${this.base}/invoice/paymentstatus?${params.toString()}`,
        { method: "GET", headers: this.headers(false) },
      );
      if (!call.ok || !isOk(call.json)) return null;
      const total = (call.json as Record<string, unknown>)["invoiceTotalAmount"];
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
      const [whole = "0", fraction = "00"] = total.toFixed(2).split(".");
      return Number(whole) * 100 + Number(fraction);
    } catch {
      return null;
    }
  }

  async issueProforma(request: InvoiceRequest): Promise<IssuedDocument> {
    this.assertConfigured("proforma");
    const json = await this.post(
      "/estimate/v2",
      buildDocumentBody(request, this.creds, "proforma"),
    );
    return this.documentFrom(json, "not_applicable");
  }

  async issueInvoice(request: InvoiceRequest): Promise<IssuedDocument> {
    this.assertConfigured("invoice");
    const body = buildDocumentBody(request, this.creds, "invoice");
    const json = await this.post("/invoice/v2", body);
    // descărcarea de gestiune o decide corpul trimis (toate produsele se descarcă ȘI gestiunea e configurată), nu cererea inițială
    const doc = this.documentFrom(json, "unknown", body["useStock"] === true);
    return { ...doc, totalMinor: await this.readTotal(doc) };
  }

  async reverseInvoice(invoice: DocumentRef, issueDate: Date): Promise<IssuedDocument> {
    this.assertConfigured("any");
    const json = await this.post("/invoice/reverse", {
      companyVatCode: this.creds.companyVatCode,
      seriesName: invoice.series,
      number: invoice.number,
      issueDate: bucharestDate(issueDate),
    });
    return this.documentFrom(json, "unknown");
  }

  async cancelProforma(proforma: DocumentRef): Promise<void> {
    this.assertConfigured("any");
    const params = new URLSearchParams({
      cif: this.creds.companyVatCode,
      seriesname: proforma.series,
      number: proforma.number,
    });
    const call = await callInvoiceProvider(
      this.options.fetch,
      `${this.base}/estimate/cancel?${params.toString()}`,
      { method: "PUT", headers: this.headers(false) },
    );
    if (!call.ok || !isOk(call.json)) this.fail(call);
  }

  private async pdf(path: string, doc: DocumentRef): Promise<InvoicePdf> {
    this.assertConfigured("any");
    const params = new URLSearchParams({
      cif: this.creds.companyVatCode,
      seriesname: doc.series,
      number: doc.number,
    });
    const call = await callInvoiceProvider(
      this.options.fetch,
      `${this.base}${path}?${params.toString()}`,
      {
        method: "GET",
        // NU «application/pdf»: SmartBill răspunde 406 la cea mai naturală valoare
        headers: { ...this.headers(false), Accept: "*/*" },
      },
    );
    const isPdf =
      call.bytes.length > 4 && new TextDecoder().decode(call.bytes.subarray(0, 4)) === "%PDF";
    if (!call.ok || !isPdf) {
      if (call.status === 502 || call.status === 404) {
        throw new IntegrationError("INVOICE_REJECTED", "Documentul nu a fost găsit la SmartBill");
      }
      this.fail(call);
    }
    return { bytes: call.bytes, contentType: "application/pdf" };
  }

  getInvoicePdf(invoice: DocumentRef): Promise<InvoicePdf> {
    return this.pdf("/invoice/pdf", invoice);
  }

  getProformaPdf(proforma: DocumentRef): Promise<InvoicePdf> {
    return this.pdf("/estimate/pdf", proforma);
  }

  /** SmartBill nu expune statusul e-Factura prin API (specificația nu are niciun endpoint): `unknown`. */
  async getEfacturaStatus(): Promise<EfacturaStatus> {
    return "unknown";
  }

  /** Citește seriile de facturi: dovedește autentificarea, CIF-ul și (dacă e configurată) existența seriei. Nu emite nimic. */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      this.assertConfigured("any");
      const params = new URLSearchParams({ cif: this.creds.companyVatCode, type: "f" });
      const call = await callInvoiceProvider(
        this.options.fetch,
        `${this.base}/series?${params.toString()}`,
        {
          method: "GET",
          headers: this.headers(false),
        },
      );
      if (!call.ok || !isOk(call.json)) this.fail(call);
      const list = (call.json as Record<string, unknown>)["list"];
      const names = Array.isArray(list)
        ? list.flatMap((item) =>
            isRecord(item) && typeof item["name"] === "string" ? [item["name"]] : [],
          )
        : [];
      if (this.creds.invoiceSeries && !names.includes(this.creds.invoiceSeries)) {
        return {
          ok: false,
          message: `Conectat la SmartBill, dar seria de facturi «${safeSnippet(this.creds.invoiceSeries, 40)}» nu există în cont.`,
        };
      }
      return { ok: true, message: "Conectat la SmartBill (autentificare și serie verificate)." };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof IntegrationError ? error.message : "SmartBill nu poate fi contactat",
      };
    }
  }
}
