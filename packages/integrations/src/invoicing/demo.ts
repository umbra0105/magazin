import { randomInt } from "node:crypto";
import {
  IntegrationError,
  exactFromMinor,
  lineByUnitPrice,
  quantityFromTicks,
  roundHalfUp,
  vatFromGross,
  type ConnectionTestResult,
  type DocumentRef,
  type EfacturaStatus,
  type InvoicePdf,
  type InvoiceProvider,
  type InvoiceRequest,
  type IssuedDocument,
} from "@ecom/shared";
import { isDemoPaymentAllowed, type DemoGuardEnv } from "../payments/demo-guard";

/**
 * Furnizorul FALS «DEMO» de facturare (Faza 13): emite documente SIMULATE, doar pentru dezvoltare și teste. Aceeași gardă ca la
 * plățile și curierii DEMO (`isDemoPaymentAllowed`): construirea aruncă într-o instalare de producție. Fără stare: seria e
 * «DEMO», numărul poartă momentul emiterii. Documentele nu sunt fiscale: PDF-ul și interfața le marchează «SIMULAT, nu este
 * document fiscal».
 *
 * Adaptorul simulat RESPINGE orice diferență de bani: recalculează fiecare linie cu regula magazinului (R1: o singură
 * rotunjire pe linie, half-up la 2 zecimale, din prețul unitar și cantitate; TVA extras din brutul liniei) și refuză cererea
 * (`INVOICE_TOTAL_MISMATCH`) dacă totalul liniei, TVA-ul liniei sau cantitatea nu coincid EXACT cu ce a încasat magazinul. Așa,
 * orice abatere a construcției facturii iese la iveală în teste, înainte de un cont real.
 */
export const DEMO_INVOICE_SERIES = "DEMO";
export const DEMO_SIMULATED_NOTICE = "SIMULAT, nu este document fiscal";

export interface DemoInvoiceProviderOptions {
  env: DemoGuardEnv;
  now?: () => Date;
  /** Doar teste: face ca emiterea să eșueze cu codul dat (pentru alerta după 3 eșecuri). */
  failWith?: { code: string; message: string } | null;
}

/** Totalul calculat de «furnizor» din liniile cererii, cu regula magazinului; aruncă la orice diferență. */
export function demoComputeTotals(request: InvoiceRequest): {
  totalMinor: number;
  taxMinor: number;
} {
  let totalMinor = 0;
  let taxMinor = 0;
  request.lines.forEach((line, index) => {
    const absTicks = line.quantityTicks < 0n ? -line.quantityTicks : line.quantityTicks;
    if (absTicks % 100n !== 0n) {
      throw new IntegrationError(
        "INVOICE_REJECTED",
        `Linia ${index + 1}: cantitatea are mai mult de 2 zecimale`,
      );
    }
    const sign = line.quantityTicks < 0n ? -1 : 1;
    const exact = lineByUnitPrice(exactFromMinor(line.unitPriceMinor), quantityFromTicks(absTicks));
    const computed = Number(roundHalfUp(exact)) * sign;
    if (computed !== line.lineTotalMinor) {
      throw new IntegrationError(
        "INVOICE_TOTAL_MISMATCH",
        `Linia ${index + 1}: furnizorul ar calcula ${computed} bani, magazinul a încasat ${line.lineTotalMinor}`,
      );
    }
    const tax = sign * vatFromGross(Math.abs(line.lineTotalMinor), line.taxRateBps);
    if (tax !== line.taxMinor) {
      throw new IntegrationError(
        "INVOICE_TOTAL_MISMATCH",
        `Linia ${index + 1}: TVA calculat ${tax} bani, TVA al magazinului ${line.taxMinor}`,
      );
    }
    totalMinor += computed;
    taxMinor += tax;
  });
  return { totalMinor, taxMinor };
}

function simulatedPdf(title: string, lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, "?");
  const body = [title, DEMO_SIMULATED_NOTICE, ...lines].map(esc);
  const stream = body
    .map((text, i) => `BT /F1 ${i < 2 ? 16 : 11} Tf 40 ${780 - i * 22} Td (${text}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export class DemoInvoiceProvider implements InvoiceProvider {
  readonly code = "demo" as const;
  readonly label = "DEMO (doar dezvoltare)";
  readonly simulated = true;
  readonly reportsEfactura = true;
  private readonly now: () => Date;

  constructor(private readonly options: DemoInvoiceProviderOptions) {
    if (!isDemoPaymentAllowed(options.env)) {
      throw new IntegrationError(
        "INVOICE_NOT_CONFIGURED",
        "Furnizorul DEMO de facturare nu este disponibil în această instalare",
      );
    }
    this.now = options.now ?? (() => new Date());
  }

  private maybeFail(): void {
    const failure = this.options.failWith;
    if (failure) throw new IntegrationError(failure.code, failure.message);
  }

  private nextNumber(): string {
    const seconds = Math.floor(this.now().getTime() / 1000);
    return `${seconds}${String(randomInt(0, 1000)).padStart(3, "0")}`;
  }

  private issue(request: InvoiceRequest, efactura: EfacturaStatus): IssuedDocument {
    this.maybeFail();
    const totals = demoComputeTotals(request);
    const number = this.nextNumber();
    return {
      series: DEMO_INVOICE_SERIES,
      number,
      providerRef: `demo-${number}`,
      viewUrl: null,
      simulated: true,
      efacturaStatus: efactura,
      totalMinor: totals.totalMinor,
      taxMinor: totals.taxMinor,
    };
  }

  async issueProforma(request: InvoiceRequest): Promise<IssuedDocument> {
    return this.issue(request, "not_applicable");
  }

  async issueInvoice(request: InvoiceRequest): Promise<IssuedDocument> {
    return this.issue(request, "pending");
  }

  async reverseInvoice(): Promise<IssuedDocument> {
    this.maybeFail();
    const number = this.nextNumber();
    return {
      series: DEMO_INVOICE_SERIES,
      number,
      providerRef: `demo-${number}`,
      viewUrl: null,
      simulated: true,
      efacturaStatus: "pending",
      totalMinor: null,
      taxMinor: null,
    };
  }

  async cancelProforma(proforma?: DocumentRef): Promise<void> {
    void proforma;
    this.maybeFail();
  }

  async getInvoicePdf(invoice: DocumentRef): Promise<InvoicePdf> {
    return {
      contentType: "application/pdf",
      bytes: simulatedPdf(`Factura ${invoice.series} ${invoice.number}`, [
        "Document generat de furnizorul DEMO.",
      ]),
    };
  }

  async getProformaPdf(proforma: DocumentRef): Promise<InvoicePdf> {
    return {
      contentType: "application/pdf",
      bytes: simulatedPdf(`Proforma ${proforma.series} ${proforma.number}`, [
        "Document generat de furnizorul DEMO.",
      ]),
    };
  }

  async getEfacturaStatus(): Promise<EfacturaStatus> {
    return "validated";
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, message: "Furnizor DEMO: nu contactează niciun serviciu real." };
  }
}
