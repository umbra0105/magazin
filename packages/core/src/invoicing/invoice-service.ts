import { Prisma, type PrismaClient } from "@ecom/db";
import {
  IntegrationError,
  isSafeToRetryInvoiceError,
  type DocumentRef,
  type EfacturaStatus,
  type InvoiceClient,
  type InvoicePdf,
  type InvoiceProvider,
  type InvoiceProviderCode,
  type InvoiceRequest,
  type IssuedDocument,
} from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { ORDER_REF_TYPE } from "../inventory/constants";
import { StockService } from "../inventory/stock-service";
import { notifyAdmins, orderContext } from "../notifications/admin-notifications";
import { addOrderEvent } from "../orders/order-service";
import {
  InvoiceDraftError,
  buildInvoiceDraft,
  collapseInexactLines,
  negateLines,
  toDocLines,
  type DraftLine,
  type StornoRequestLine,
} from "./invoice-draft";
import { enqueueInvoiceAlertEmail } from "./invoice-alert";
import { queuePartialStorno } from "./partial-storno";
import { invoicePaymentType } from "./invoice-rules";
import { readInvoicingSettings, type InvoicingSettings } from "./invoice-settings";
import {
  loadInvoiceFacts,
  queueIssue,
  queueReverse,
  selectedInvoiceProvider,
} from "./invoice-schedule";

/**
 * Serviciul facturării (Faza 13): emiterea documentelor din outbox (`invoice`), prin `InvoiceProvider`, cu reîncercări, alertă și
 * stornări. Apelurile către furnizor se fac ÎN AFARA tranzacțiilor; scrierile după apel sunt scurte. Regulile de siguranță:
 *
 *  - un document poate fi emis o singură dată: rândul are unicitate pe `(comandă, docKey)`, iar preluarea din coadă e atomică
 *    (`FOR UPDATE SKIP LOCKED`), deci două workere nu emit același document;
 *  - EMITERE cu rezultat NESIGUR (timp depășit, răspuns neinterpretabil, proces căzut în timpul apelului) NU se reîncearcă singură:
 *    documentul poate exista deja la furnizor, iar numerotarea e a lor; adminul verifică în cont și apasă «Reîncearcă»;
 *  - factura NU se păstrează cu alte sume decât cele încasate: construirea refuză (`InvoiceDraftError`), iar un total diferit
 *    raportat de furnizor (dacă îl expune) se înregistrează ca alertă imediată;
 *  - către furnizor pleacă doar ce cere factura; în `lastError` și în jurnal nu intră date personale (mesajele adaptoarelor sunt
 *    fără corpul cererii), iar costul de achiziție nu apare nicăieri aici.
 */
export { INVOICE_SERVICE_CODES, InvoiceServiceError } from "./invoice-service-error";
import { InvoiceServiceError } from "./invoice-service-error";

/** De unde vine furnizorul de facturare (configurat, cu chei decriptate și garda LIVE). */
export interface InvoiceProviderSource {
  /** Furnizorul pe care îl folosește acum magazinul pentru documente NOI (ales, activ, configurat, verificat în LIVE), sau `null`. */
  active(): Promise<InvoiceProviderCode | null>;
  /** Furnizorul pentru un cod, sau `null` dacă nu e configurat sau nu are voie să ruleze (LIVE neverificat). */
  provider(code: InvoiceProviderCode): Promise<InvoiceProvider | null>;
}

export interface InvoiceServiceDeps {
  db: PrismaClient;
  source: InvoiceProviderSource;
  now?: () => Date;
}

const MINUTE = 60_000;

/** Codurile după care documentul POATE exista deja la furnizor: reîncercarea cere confirmarea adminului. */
const UNCERTAIN_CODES: ReadonlySet<string> = new Set([
  "INVOICE_OUTCOME_UNKNOWN",
  "INVOICE_PROVIDER_TIMEOUT",
  "INVOICE_BAD_RESPONSE",
]);
/** Reîncercarea după acest cod cere confirmarea că documentul NU există la furnizor (rezultat nesigur). */
export const isUncertainInvoiceCode = (code: string | null): boolean =>
  code !== null && UNCERTAIN_CODES.has(code);

const DOC_SELECT = {
  id: true,
  orderId: true,
  kind: true,
  docKey: true,
  parentId: true,
  status: true,
  attempts: true,
  totalMinor: true,
  taxMinor: true,
  useStock: true,
  alertedAt: true,
  requestedBy: true,
} as const;
const BATCH = 5;

const clip = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

interface DocRow {
  id: string;
  orderId: string;
  kind: string;
  docKey: string;
  parentId: string | null;
  status: string;
  attempts: number;
  totalMinor: number;
  taxMinor: number;
  useStock: boolean;
  alertedAt: Date | null;
  requestedBy: string | null;
}

export interface ProcessSummary {
  recovered: number;
  processed: number;
  issued: number;
  failed: number;
}

export class InvoiceService {
  private readonly db: PrismaClient;
  private readonly source: InvoiceProviderSource;
  private readonly now: () => Date;

  constructor(deps: InvoiceServiceDeps) {
    this.db = deps.db;
    this.source = deps.source;
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Coada: preluare, recuperare, procesare
  // -------------------------------------------------------------------------

  /** Preia atomic documentele scadente (`queued` → `issuing`). Două workere nu primesc niciodată același rând. */
  async claimDue(limit = BATCH): Promise<string[]> {
    const now = this.now();
    const rows = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE invoice SET status = 'issuing', "lockedAt" = ${now}, "updatedAt" = ${now}
      WHERE id IN (
        SELECT id FROM invoice
        WHERE status = 'queued' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt", id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit})
      RETURNING id`);
    return rows.map((r) => r.id);
  }

  /** Id-urile documentelor scadente (în coadă), fără să le preia: pentru măturător, care le pune în coada BullMQ. */
  async listDueIds(limit = 50): Promise<string[]> {
    const now = this.now();
    const rows = await this.db.invoice.findMany({
      where: { status: "queued", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Preia atomic UN document (queued → issuing) și îl procesează. Dacă altcineva l-a preluat deja, nu face nimic. */
  async processById(id: string): Promise<"issued" | "failed" | "requeued" | "skipped" | "ignored"> {
    const now = this.now();
    const claimed = await this.db.invoice.updateMany({
      where: {
        id,
        status: "queued",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: { status: "issuing", lockedAt: now },
    });
    if (claimed.count !== 1) return "ignored";
    return this.processOne(id);
  }

  /**
   * Un document rămas «în emitere» peste `leaseMinutes` (procesul a căzut în timpul apelului) are rezultat NESIGUR: trece în
   * «eșuat», cu alertă, fără reîncercare automată.
   */
  async recoverStale(): Promise<number> {
    const settings = await readInvoicingSettings(this.db);
    const cutoff = new Date(this.now().getTime() - settings.leaseMinutes * MINUTE);
    const stale = await this.db.invoice.findMany({
      where: { status: "issuing", lockedAt: { lt: cutoff } },
      select: { id: true },
    });
    let count = 0;
    for (const { id } of stale) {
      const done = await this.markFailed(
        id,
        "INVOICE_OUTCOME_UNKNOWN",
        "Emiterea a fost întreruptă: rezultatul e nesigur. Verifică în contul furnizorului dacă documentul există, apoi apasă «Reîncearcă».",
        { fromStatus: "issuing", countAttempt: true },
      );
      if (done) count += 1;
    }
    return count;
  }

  /** Un ciclu al lucrătorului: recuperare și preluare, apoi procesare. Starea e-Factura se reîmprospătează separat (`refreshEfactura`). */
  async processDue(limit = BATCH): Promise<ProcessSummary> {
    const recovered = await this.recoverStale();
    const ids = await this.claimDue(limit);
    const summary: ProcessSummary = { recovered, processed: 0, issued: 0, failed: 0 };
    for (const id of ids) {
      const outcome = await this.processOne(id);
      summary.processed += 1;
      if (outcome === "issued") summary.issued += 1;
      if (outcome === "failed") summary.failed += 1;
    }
    return summary;
  }

  /** Procesează un document aflat în `issuing` (preluat de `claimDue`). */
  async processOne(id: string): Promise<"issued" | "failed" | "requeued" | "skipped" | "ignored"> {
    const doc = await this.db.invoice.findUnique({
      where: { id },
      select: DOC_SELECT,
    });
    if (!doc || doc.status !== "issuing") return "ignored";
    try {
      return await this.execute(doc);
    } catch (error) {
      return this.handleError(doc, error);
    }
  }

  private async execute(
    doc: DocRow,
  ): Promise<"issued" | "failed" | "requeued" | "skipped" | "ignored"> {
    if (doc.kind === "storno") return this.executeStorno(doc);
    const settings = await readInvoicingSettings(this.db);
    const code = await this.source.active();
    const provider = code ? await this.source.provider(code) : null;
    if (!provider)
      throw new IntegrationError(
        "INVOICE_NOT_CONFIGURED",
        "Furnizorul de facturare nu e configurat",
      );

    if (doc.kind === "invoice") {
      const proforma = await this.db.invoice.findUnique({
        where: { orderId_docKey: { orderId: doc.orderId, docKey: "proforma" } },
        select: { status: true },
      });
      if (proforma && (proforma.status === "queued" || proforma.status === "issuing")) {
        await this.requeue(
          doc.id,
          1 * MINUTE,
          "Proforma comenzii e în curs de emitere: factura așteaptă",
        );
        return "requeued";
      }
    }
    const { request, lines, useStock } = await this.prepare(doc, settings);
    await this.persistLines(doc, lines, useStock);
    const issued =
      doc.kind === "proforma"
        ? await provider.issueProforma(request)
        : await provider.issueInvoice(request);
    return this.finish(doc, provider, issued, {});
  }

  /**
   * Încheie un document deja emis la furnizor. O eroare AICI (baza de date, o regulă încălcată) nu se reîncearcă: documentul există la
   * furnizor, iar o a doua emitere l-ar dubla. Documentul trece în «eșuat» cu rezultat nesigur, iar adminul verifică în contul furnizorului.
   */
  private async finish(
    doc: DocRow,
    provider: InvoiceProvider,
    issued: IssuedDocument,
    opts: { negative?: boolean },
  ): Promise<"issued"> {
    try {
      return await this.complete(doc, provider, issued, opts);
    } catch {
      throw new InvoiceServiceError(
        "INVOICE_OUTCOME_UNKNOWN",
        "Documentul a fost emis la furnizor, dar nu s-a putut înregistra aici: verifică în contul furnizorului și apasă «Reîncearcă» doar dacă documentul NU există",
      );
    }
  }

  private async executeStorno(
    doc: DocRow,
  ): Promise<"issued" | "failed" | "requeued" | "skipped" | "ignored"> {
    if (!doc.parentId)
      throw new InvoiceServiceError(
        "INVOICE_PARENT_UNRESOLVED",
        "Stornoul nu are document-părinte",
      );
    const parent = await this.db.invoice.findUnique({
      where: { id: doc.parentId },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    if (!parent)
      throw new InvoiceServiceError("INVOICE_PARENT_UNRESOLVED", "Documentul-părinte nu există");

    // părintele nu a fost emis încă
    if (parent.status === "queued" && parent.attempts === 0) {
      await this.skipPair(
        doc.id,
        parent.id,
        "Documentul de stornat nu a apucat să fie emis: nu mai e nimic de stornat",
      );
      return "skipped";
    }
    if (parent.status === "skipped") {
      await this.setSkipped(
        doc.id,
        "Documentul de stornat a fost sărit: nu mai e nimic de stornat",
      );
      return "skipped";
    }
    if (parent.status !== "issued") {
      if (parent.status === "queued" || parent.status === "issuing") {
        await this.requeue(
          doc.id,
          1 * MINUTE,
          "Documentul de stornat e în curs de emitere: stornoul așteaptă",
        );
        return "requeued";
      }
      throw new InvoiceServiceError(
        "INVOICE_PARENT_UNRESOLVED",
        "Documentul de stornat nu e emis sau rezultatul lui e nesigur: verifică în contul furnizorului",
      );
    }
    const providerCode = parent.provider as InvoiceProviderCode;
    const provider = await this.source.provider(providerCode);
    if (!provider)
      throw new IntegrationError(
        "INVOICE_NOT_CONFIGURED",
        "Furnizorul de facturare nu e configurat",
      );
    const ref: DocumentRef = { series: parent.series as string, number: parent.number as string };
    const issueDate = this.now();

    // apărare în plus (mini-faza storno-total): suma tuturor stornourilor facturii, cu cel de față, nu depășește totalul ei; altfel
    // documentul NU ajunge la furnizor, ci trece în «eșuat», cu alertă (comanda nu se blochează)
    let alreadyReversedMinor = 0;
    let hasPartials = false;
    if (doc.docKey !== "storno:proforma") {
      const others = await this.db.invoice.findMany({
        where: {
          orderId: doc.orderId,
          kind: "storno",
          parentId: parent.id,
          docKey: { startsWith: "storno:" },
          status: { not: "skipped" },
          id: { not: doc.id },
        },
        select: { totalMinor: true, docKey: true },
      });
      alreadyReversedMinor = others.reduce((acc, o) => acc + o.totalMinor, 0);
      hasPartials = others.some((o) => o.docKey !== "storno:total");
      if (alreadyReversedMinor + doc.totalMinor > parent.totalMinor) {
        throw new InvoiceServiceError(
          "INVOICE_STORNO_EXCEEDS_TOTAL",
          `Stornourile (${alreadyReversedMinor + doc.totalMinor} bani) ar depăși totalul facturii (${parent.totalMinor} bani): documentul nu se trimite furnizorului`,
        );
      }
    }
    const reversal = { invoiceTotalMinor: parent.totalMinor, alreadyReversedMinor };
    // stornoul «total» pe tot documentul (fără stornouri parțiale) merge prin `reverseInvoice`; cu stornouri parțiale e restul pe
    // linii, emis ca factură cu cantități negative, ca stornoul parțial
    const wholeDocument = doc.docKey === "storno:total" && !hasPartials;

    // liniile stornoului total = liniile documentului de stornat (pentru afișare), păstrate o singură dată
    const own = await this.db.invoiceLine.count({ where: { invoiceId: doc.id } });
    if (own === 0 && wholeDocument) {
      await this.db.invoiceLine.createMany({
        data: parent.lines.map((l) => ({
          invoiceId: doc.id,
          position: l.position,
          kind: l.kind,
          orderLineId: l.orderLineId,
          sku: l.sku,
          title: l.title,
          unitName: l.unitName,
          quantityTicks: l.quantityTicks,
          unitPriceMinor: l.unitPriceMinor,
          lineTotalMinor: l.lineTotalMinor,
          netMinor: l.netMinor,
          taxMinor: l.taxMinor,
          taxRateBps: l.taxRateBps,
          dischargeStock: false,
        })),
      });
    }

    if (doc.docKey === "storno:proforma") {
      await provider.cancelProforma(ref);
      const synthetic: IssuedDocument = {
        series: ref.series,
        number: ref.number,
        providerRef: parent.providerRef as string,
        viewUrl: null,
        simulated: parent.simulated,
        efacturaStatus: "not_applicable",
        stockDischarged: false,
        totalMinor: null,
        taxMinor: null,
      };
      return this.finish(doc, provider, synthetic, {});
    }
    if (wholeDocument) {
      const issued = await provider.reverseInvoice(ref, issueDate, reversal);
      return this.finish(doc, provider, issued, {});
    }
    // storno parțial sau restul facturii: factură cu cantități negative (PRESUPUS pentru SmartBill: nedocumentat, vezi adaptorul)
    const lines = await this.db.invoiceLine.findMany({
      where: { invoiceId: doc.id },
      orderBy: { position: "asc" },
    });
    if (lines.length === 0) {
      throw new InvoiceServiceError("INVOICE_STATE_INVALID", "Stornoul parțial nu are linii");
    }
    const client = await this.clientOf(doc.orderId);
    const order = await this.db.order.findUnique({
      where: { id: doc.orderId },
      select: { number: true, email: true },
    });
    const stored: DraftLine[] = lines.map(toDraftLine);
    // restul facturii: brutul liniei e cel rămas EXACT, deci preț × cantitate poate diferi cu 1 ban: linia pleacă «1 × brut»
    const draftLines =
      doc.docKey === "storno:total"
        ? collapseInexactLines(stored, (await readInvoicingSettings(this.db)).serviceUnit)
        : stored;
    const request: InvoiceRequest = {
      orderNumber: `${order?.number ?? ""} (${doc.docKey === "storno:total" ? "storno rest" : "storno parțial"})`,
      client,
      lines: toDocLines(negateLines(draftLines)),
      currency: "RON",
      issueDate,
      useStock: false,
      payment: null,
      fromProforma: null,
      sendEmail: false,
      reversal,
    };
    const issued = await provider.issueInvoice(request);
    return this.finish(doc, provider, issued, { negative: true });
  }

  // -------------------------------------------------------------------------
  // Construirea cererii
  // -------------------------------------------------------------------------

  private async clientOf(orderId: string): Promise<InvoiceClient> {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      select: {
        email: true,
        phone: true,
        addresses: { where: { kind: "billing" }, take: 1 },
      },
    });
    const a = order?.addresses[0];
    if (!order || !a)
      throw new InvoiceDraftError(
        "INVOICE_UNSUPPORTED_ORDER",
        "Comanda nu are adresă de facturare",
      );
    const vat = a.vatId?.trim() ?? "";
    return {
      name: a.company?.trim() ? a.company.trim() : a.fullName,
      vatCode: vat !== "" ? vat : null,
      isTaxPayer: /^RO/i.test(vat),
      regCom: a.tradeRegisterNo ?? null,
      address: a.street,
      city: a.localityName,
      county: a.countyName,
      country: a.country === "RO" ? "Romania" : a.country,
      email: order.email,
      phone: a.phone || order.phone,
    };
  }

  private async prepare(
    doc: DocRow,
    settings: InvoicingSettings,
  ): Promise<{ request: InvoiceRequest; lines: DraftLine[]; useStock: boolean }> {
    const order = await this.db.order.findUnique({
      where: { id: doc.orderId },
      include: { lines: { orderBy: { createdAt: "asc" } } },
    });
    if (!order) throw new InvoiceServiceError("INVOICE_NOT_FOUND", "Comanda nu există");
    const existing = await this.db.invoiceLine.findMany({
      where: { invoiceId: doc.id },
      orderBy: { position: "asc" },
    });
    let lines: DraftLine[];
    let useStock = doc.useStock;
    if (existing.length > 0) {
      lines = existing.map(toDraftLine);
    } else {
      const commitments = await this.db.stockCommitment.findMany({
        where: { refType: ORDER_REF_TYPE, refId: order.id, status: "open" },
        select: { variantId: true },
      });
      const dischargeable = new Set(commitments.map((c) => c.variantId));
      const draft = buildInvoiceDraft(
        {
          lines: order.lines.map((l) => ({
            id: l.id,
            sku: l.sku,
            title: l.title,
            variantTitle: l.variantTitle,
            quantityTicks: l.quantity,
            unitSymbol: l.unitSymbol,
            unitPriceMinor: l.unitPriceMinor,
            lineTotalMinor: l.lineTotalMinor,
            netMinor: l.netMinor,
            taxMinor: l.taxMinor,
            taxRateBps: l.taxRateBps,
            dischargeable: l.variantId !== null && dischargeable.has(l.variantId),
            digital: l.isDigital,
          })),
          discountMinor: order.discountMinor,
          shippingMinor: order.shippingMinor,
          shippingTaxMinor: order.shippingTaxMinor,
          codFeeMinor: order.codFeeMinor,
          codFeeTaxMinor: order.codFeeTaxMinor,
          taxMinor: order.taxMinor,
          totalMinor: order.totalMinor,
          taxRateBps: order.taxRateBps,
        },
        {
          unitName: (symbol) => settings.unitNames[symbol] ?? symbol,
          labels: {
            shipping: settings.shippingLabel,
            codFee: settings.codFeeLabel,
            serviceUnit: settings.serviceUnit,
          },
        },
      );
      lines = draft.lines;
      useStock = doc.kind === "invoice" && draft.useStock;
    }
    let fromProforma: DocumentRef | null = null;
    if (doc.kind === "invoice") {
      const proforma = await this.db.invoice.findUnique({
        where: { orderId_docKey: { orderId: order.id, docKey: "proforma" } },
        select: { status: true, series: true, number: true },
      });
      if (proforma?.status === "issued" && proforma.series && proforma.number) {
        fromProforma = { series: proforma.series, number: proforma.number };
      }
    }
    const method = order.paymentMethod as "cod" | "bank_transfer" | "card";
    const paymentType = doc.kind === "invoice" ? invoicePaymentType(method) : null;
    const request: InvoiceRequest = {
      orderNumber: order.number,
      client: await this.clientOf(order.id),
      lines: toDocLines(lines),
      currency: order.currency,
      issueDate: this.now(),
      useStock,
      payment: paymentType ? { type: paymentType, valueMinor: order.totalMinor } : null,
      fromProforma,
      sendEmail: settings.sendEmailByProvider,
    };
    return { request, lines, useStock };
  }

  private async persistLines(doc: DocRow, lines: DraftLine[], useStock: boolean): Promise<void> {
    const count = await this.db.invoiceLine.count({ where: { invoiceId: doc.id } });
    if (count > 0) return;
    await inTx(this.db, async (tx) => {
      await tx.invoiceLine.createMany({
        data: lines.map((l, index) => ({
          invoiceId: doc.id,
          position: index + 1,
          kind: l.kind,
          orderLineId: l.orderLineId,
          sku: l.sku,
          title: l.title,
          unitName: l.unitName,
          quantityTicks: l.quantityTicks,
          unitPriceMinor: l.unitPriceMinor,
          lineTotalMinor: l.lineTotalMinor,
          netMinor: l.netMinor,
          taxMinor: l.taxMinor,
          taxRateBps: l.taxRateBps,
          dischargeStock: l.dischargeStock,
        })),
      });
      await tx.invoice.update({ where: { id: doc.id }, data: { useStock } });
    });
  }

  // -------------------------------------------------------------------------
  // Încheierea: succes, eroare, alertă
  // -------------------------------------------------------------------------

  private async complete(
    doc: DocRow,
    provider: InvoiceProvider,
    issued: IssuedDocument,
    opts: { negative?: boolean },
  ): Promise<"issued"> {
    const now = this.now();
    const expectedTotal = opts.negative ? -doc.totalMinor : doc.totalMinor;
    const mismatch =
      issued.totalMinor !== null &&
      Math.abs(issued.totalMinor) !== Math.abs(expectedTotal) &&
      doc.kind !== "storno"
        ? { provider: issued.totalMinor, shop: expectedTotal }
        : null;
    await inTx(this.db, async (tx) => {
      await tx.invoice.update({
        where: { id: doc.id },
        data: {
          status: "issued",
          provider: provider.code,
          simulated: issued.simulated,
          series: issued.series,
          number: issued.number,
          providerRef: issued.providerRef,
          pdfUrl: issued.viewUrl,
          efacturaStatus: doc.kind === "proforma" ? "not_applicable" : issued.efacturaStatus,
          // ce s-a întâmplat DE FAPT la furnizor (descărcat sau nu), nu ce s-a cerut
          useStock: issued.stockDischarged,
          issuedAt: now,
          attempts: { increment: 1 },
          lockedAt: null,
          nextAttemptAt: null,
          lastErrorCode: mismatch ? "INVOICE_TOTAL_MISMATCH" : null,
          lastError: mismatch
            ? clip(
                `Totalul de la furnizor (${mismatch.provider} bani) diferă de ce a încasat magazinul (${mismatch.shop} bani)`,
              )
            : null,
        },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId: doc.id,
          type: "issued",
          message: `Document emis: ${issued.series} ${issued.number}${issued.simulated ? " (SIMULAT, nu este document fiscal)" : ""}`,
        },
      });
      const label =
        doc.kind === "proforma"
          ? "Proformă emisă"
          : doc.kind === "storno"
            ? doc.docKey === "storno:proforma"
              ? "Proformă anulată"
              : "Factură stornată"
            : "Factură emisă";
      await addOrderEvent(tx, doc.orderId, {
        type: doc.kind === "storno" ? "invoice.reversed" : `invoice.${doc.kind}_issued`,
        message: `${label}: ${issued.series} ${issued.number}${issued.simulated ? " (SIMULAT)" : ""}`,
        data: { invoiceId: doc.id },
      });
      if (doc.kind === "invoice" && issued.stockDischarged) {
        // factura cu descărcare de gestiune: ora ei intră în regula «poză + angajat» (o bucată se scade o singură dată)
        await new StockService({ db: tx, now: () => now }).markInvoiced(
          { refType: ORDER_REF_TYPE, refId: doc.orderId },
          now,
        );
      }
      if (mismatch) {
        await this.raiseAlert(tx, doc, "Totalul de la furnizor diferă de ce a încasat magazinul");
      }
    });
    return "issued";
  }

  private async handleError(doc: DocRow, error: unknown): Promise<"failed" | "requeued"> {
    const settings = await readInvoicingSettings(this.db);
    if (error instanceof IntegrationError && error.code === "INVOICE_NOT_CONFIGURED") {
      // nu e o încercare: furnizorul nu e (încă) configurat; documentul așteaptă
      await this.requeue(doc.id, settings.backoffMinutes[0]! * MINUTE, error.message, error.code);
      return "requeued";
    }
    if (error instanceof InvoiceDraftError || error instanceof InvoiceServiceError) {
      await this.markFailed(doc.id, error.code, error.message, {
        fromStatus: "issuing",
        countAttempt: true,
      });
      return "failed";
    }
    if (error instanceof IntegrationError) {
      if (
        error.code === "INVOICE_TOTAL_MISMATCH" ||
        error.code === "INVOICE_STORNO_EXCEEDS_TOTAL"
      ) {
        await this.markFailed(doc.id, error.code, error.message, {
          fromStatus: "issuing",
          countAttempt: true,
        });
        return "failed";
      }
      if (!isSafeToRetryInvoiceError(error.code)) {
        await this.markFailed(
          doc.id,
          error.code,
          `Rezultat nesigur: ${error.message}. Verifică în contul furnizorului dacă documentul există, apoi apasă «Reîncearcă».`,
          { fromStatus: "issuing", countAttempt: true },
        );
        return "failed";
      }
      return this.failWithBackoff(doc, error.code, error.message, settings);
    }
    return this.failWithBackoff(
      doc,
      "INVOICE_UNEXPECTED",
      "Eroare neașteptată la emitere",
      settings,
    );
  }

  private async failWithBackoff(
    doc: DocRow,
    code: string,
    message: string,
    settings: InvoicingSettings,
  ): Promise<"failed" | "requeued"> {
    const attempts = doc.attempts + 1;
    if (attempts >= settings.maxAttempts) {
      await this.markFailed(doc.id, code, `${message} (după ${attempts} încercări)`, {
        fromStatus: "issuing",
        countAttempt: true,
      });
      return "failed";
    }
    const wait =
      settings.backoffMinutes[Math.min(attempts - 1, settings.backoffMinutes.length - 1)] ?? 5;
    const now = this.now();
    await inTx(this.db, async (tx) => {
      await tx.invoice.update({
        where: { id: doc.id },
        data: {
          status: "queued",
          attempts,
          lockedAt: null,
          nextAttemptAt: new Date(now.getTime() + wait * MINUTE),
          lastErrorCode: code,
          lastError: clip(message),
        },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId: doc.id,
          type: "attempt_failed",
          message: `Încercarea ${attempts} a eșuat (${code}); următoarea peste ${wait} min`,
          data: { code },
        },
      });
      if (attempts >= settings.alertAfterFailures && doc.alertedAt === null) {
        await this.raiseAlert(tx, doc, `${attempts} încercări eșuate de emitere`);
      }
    });
    return "requeued";
  }

  /** Trece documentul în «eșuat» (dead-letter): cere decizia adminului. Alertă imediată. */
  private async markFailed(
    id: string,
    code: string,
    message: string,
    opts: { fromStatus: string; countAttempt: boolean },
  ): Promise<boolean> {
    const doc = await this.db.invoice.findUnique({
      where: { id },
      select: DOC_SELECT,
    });
    if (!doc || doc.status !== opts.fromStatus) return false;
    await inTx(this.db, async (tx) => {
      const changed = await tx.invoice.updateMany({
        where: { id, status: opts.fromStatus },
        data: {
          status: "failed",
          lockedAt: null,
          nextAttemptAt: null,
          lastErrorCode: code,
          lastError: clip(message),
          ...(opts.countAttempt ? { attempts: { increment: 1 } } : {}),
        },
      });
      if (changed.count === 0) return;
      await tx.invoiceEvent.create({
        data: {
          invoiceId: id,
          type: "failed",
          message: clip(`Eșuat (${code}): ${message}`),
          data: { code },
        },
      });
      await this.raiseAlert(tx, doc, "Documentul fiscal nu s-a putut emite");
    });
    return true;
  }

  private async requeue(
    id: string,
    delayMs: number,
    message: string,
    code?: string,
  ): Promise<void> {
    await this.db.invoice.update({
      where: { id },
      data: {
        status: "queued",
        lockedAt: null,
        nextAttemptAt: new Date(this.now().getTime() + delayMs),
        ...(code ? { lastErrorCode: code, lastError: clip(message) } : {}),
      },
    });
  }

  private async setSkipped(id: string, message: string): Promise<void> {
    await inTx(this.db, async (tx) => {
      await tx.invoice.update({
        where: { id },
        data: { status: "skipped", lockedAt: null, nextAttemptAt: null },
      });
      await tx.invoiceEvent.create({ data: { invoiceId: id, type: "skipped", message } });
    });
  }

  private async skipPair(stornoId: string, parentId: string, message: string): Promise<void> {
    await inTx(this.db, async (tx) => {
      for (const id of [stornoId, parentId]) {
        await tx.invoice.update({
          where: { id },
          data: { status: "skipped", lockedAt: null, nextAttemptAt: null },
        });
        await tx.invoiceEvent.create({ data: { invoiceId: id, type: "skipped", message } });
      }
    });
  }

  /** Alerta din admin (o singură dată pe document): clopoțelul. Emailul intern îl pune în coadă `enqueueInvoiceAlertEmail`. */
  private async raiseAlert(
    tx: Db,
    doc: Pick<DocRow, "id" | "orderId" | "kind">,
    reason: string,
  ): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: doc.orderId },
      select: { number: true },
    });
    const created = await notifyAdmins(tx, {
      kind: "invoice_failed",
      title: doc.kind === "storno" ? "Stornoul nu s-a putut emite" : "Factura nu s-a putut emite",
      context: orderContext(order?.number ?? "", reason),
      href: `/admin/comenzi/${doc.orderId}`,
      permission: "invoices.read",
      dedupKey: `invoice-failed:${doc.id}`,
    });
    await tx.invoice.update({ where: { id: doc.id }, data: { alertedAt: this.now() } });
    if (created) {
      await tx.invoiceEvent.create({
        data: { invoiceId: doc.id, type: "alert", message: "Alertă trimisă adminilor" },
      });
      await enqueueInvoiceAlertEmail(tx, { invoiceId: doc.id, orderId: doc.orderId, reason });
    }
  }

  // -------------------------------------------------------------------------
  // Acțiuni de admin (scrierea în auditLog o face acțiunea din `apps/web`)
  // -------------------------------------------------------------------------

  /**
   * «Reîncearcă»: un document eșuat revine în coadă. La rezultat nesigur (`INVOICE_OUTCOME_UNKNOWN`, timp depășit) adminul
   * trebuie să confirme că a verificat în contul furnizorului că documentul NU există (`confirmNotIssued`).
   */
  async retry(invoiceId: string, actorLabel: string, confirmNotIssued: boolean): Promise<void> {
    await inTx(this.db, async (tx) => {
      const doc = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!doc) throw new InvoiceServiceError("INVOICE_NOT_FOUND", "Documentul nu există");
      if (doc.status !== "failed") {
        throw new InvoiceServiceError(
          "INVOICE_STATE_INVALID",
          "Doar un document eșuat poate fi reîncercat",
        );
      }
      const uncertain = doc.lastErrorCode !== null && UNCERTAIN_CODES.has(doc.lastErrorCode);
      if (uncertain && !confirmNotIssued) {
        throw new InvoiceServiceError(
          "INVOICE_OUTCOME_UNKNOWN",
          "Rezultatul emiterii anterioare e nesigur: confirmă că ai verificat în contul furnizorului că documentul nu există",
        );
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: "queued",
          attempts: 0,
          nextAttemptAt: null,
          lockedAt: null,
          alertedAt: null,
        },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          type: "retry_requested",
          message: `Retrimis de ${actorLabel}${uncertain ? " (după verificarea în contul furnizorului)" : ""}`,
        },
      });
      await addOrderEvent(tx, doc.orderId, {
        type: "invoice.retry",
        message: `Emiterea documentului a fost reîncercată de ${actorLabel}`,
        actorLabel,
        data: { invoiceId, docKey: doc.docKey },
      });
    });
  }

  /** Emite acum documentul unei comenzi (din lista «confirmate fără factură», când facturarea automată era oprită sau a ratat). */
  async requestInvoice(orderId: string, actorLabel: string): Promise<string | null> {
    return inTx(this.db, async (tx) => {
      const facts = await loadInvoiceFacts(tx, orderId);
      if (!facts || facts.external) {
        throw new InvoiceServiceError(
          "INVOICE_ORDER_NOT_ELIGIBLE",
          "Comanda nu se poate factura din magazin",
        );
      }
      if (!(await selectedInvoiceProvider(tx))) {
        throw new InvoiceServiceError(
          "INVOICE_NO_PROVIDER",
          "Alege și activează un furnizor de facturare în setări",
        );
      }
      const id = await queueIssue(tx, orderId, "invoice", facts, {
        trigger: "manual",
        requestedBy: actorLabel,
      });
      if (id) {
        await addOrderEvent(tx, orderId, {
          type: "invoice.requested",
          message: `Factura a fost cerută din admin de ${actorLabel} (în coadă)`,
          actorLabel,
          data: { invoiceId: id },
        });
      }
      return id;
    });
  }

  /** Stornoul TOTAL cerut din admin (de exemplu o comandă livrată și apoi refuzată). */
  async requestReverse(orderId: string, actorLabel: string): Promise<string | null> {
    return inTx(this.db, async (tx) => {
      if (!(await selectedInvoiceProvider(tx))) {
        throw new InvoiceServiceError(
          "INVOICE_NO_PROVIDER",
          "Alege și activează un furnizor de facturare în setări",
        );
      }
      const id = await queueReverse(tx, orderId, { trigger: "manual", requestedBy: actorLabel });
      if (id) {
        await addOrderEvent(tx, orderId, {
          type: "invoice.reverse_requested",
          message: `Stornoul a fost cerut din admin de ${actorLabel} (în coadă)`,
          actorLabel,
          data: { invoiceId: id },
        });
      }
      return id;
    });
  }

  /**
   * Storno PARȚIAL pe produse (retur parțial). Logica stă în `queuePartialStorno` (`partial-storno.ts`), apelabilă și din tranzacția
   * rambursării unui retur (Faza 14).
   */
  async requestPartialStorno(
    orderId: string,
    reference: string,
    returns: readonly StornoRequestLine[],
    actorLabel: string,
  ): Promise<string | null> {
    return queuePartialStorno(this.db, orderId, reference, returns, actorLabel);
  }

  /**
   * Starea e-Factura se poate marca manual (SmartBill nu o expune prin API): adminul a verificat în contul furnizorului.
   */
  async setEfacturaStatus(
    invoiceId: string,
    status: EfacturaStatus,
    actorLabel: string,
  ): Promise<void> {
    await inTx(this.db, async (tx) => {
      const doc = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!doc || doc.status !== "issued" || doc.kind === "proforma") {
        throw new InvoiceServiceError(
          "INVOICE_STATE_INVALID",
          "Starea e-Factura se setează doar pe o factură emisă",
        );
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { efacturaStatus: status, efacturaCheckedAt: this.now() },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          type: "efactura",
          message: `e-Factura marcată «${status}» de ${actorLabel}`,
        },
      });
      await addOrderEvent(tx, doc.orderId, {
        type: "invoice.efactura",
        message: `Starea e-Factura a documentului a fost marcată «${status}» de ${actorLabel}`,
        actorLabel,
        data: { invoiceId, status },
      });
    });
  }

  /** PDF-ul documentului, de la furnizor (nu se păstrează local). */
  async pdf(invoiceId: string): Promise<{ pdf: InvoicePdf; fileName: string }> {
    const doc = await this.db.invoice.findUnique({ where: { id: invoiceId } });
    if (!doc || doc.status !== "issued" || !doc.series || !doc.number || !doc.provider) {
      throw new InvoiceServiceError("INVOICE_STATE_INVALID", "Documentul nu e emis");
    }
    const provider = await this.source.provider(doc.provider as InvoiceProviderCode);
    if (!provider)
      throw new InvoiceServiceError(
        "INVOICE_NO_PROVIDER",
        "Furnizorul de facturare nu e configurat",
      );
    const ref = { series: doc.series, number: doc.number };
    const pdf =
      doc.kind === "proforma"
        ? await provider.getProformaPdf(ref)
        : await provider.getInvoicePdf(ref);
    return {
      pdf,
      fileName: `${doc.kind === "proforma" ? "proforma" : "factura"}-${doc.series}${doc.number}.pdf`,
    };
  }

  /** Reîmprospătează starea e-Factura a documentelor la care furnizorul o raportează (SmartBill: niciodată). */
  async refreshEfactura(limit = 20): Promise<number> {
    const docs = await this.db.invoice.findMany({
      where: {
        status: "issued",
        kind: { in: ["invoice", "storno"] },
        efacturaStatus: { in: ["pending", "sent"] },
        provider: "demo",
      },
      orderBy: { efacturaCheckedAt: { sort: "asc", nulls: "first" } },
      take: limit,
    });
    let changed = 0;
    for (const doc of docs) {
      const provider = await this.source.provider(doc.provider as InvoiceProviderCode);
      if (!provider?.reportsEfactura || !doc.series || !doc.number) continue;
      try {
        const status = await provider.getEfacturaStatus({ series: doc.series, number: doc.number });
        await this.db.invoice.update({
          where: { id: doc.id },
          data: { efacturaStatus: status, efacturaCheckedAt: this.now() },
        });
        if (status !== doc.efacturaStatus) changed += 1;
      } catch {
        // starea se mai citește la ciclul următor
      }
    }
    return changed;
  }
}

function toDraftLine(l: {
  kind: string;
  orderLineId: string | null;
  sku: string | null;
  title: string;
  unitName: string;
  quantityTicks: bigint;
  unitPriceMinor: number;
  lineTotalMinor: number;
  netMinor: number;
  taxMinor: number;
  taxRateBps: number;
  dischargeStock: boolean;
}): DraftLine {
  return {
    kind: l.kind as DraftLine["kind"],
    orderLineId: l.orderLineId,
    sku: l.sku,
    title: l.title,
    unitName: l.unitName,
    quantityTicks: l.quantityTicks,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: l.lineTotalMinor,
    netMinor: l.netMinor,
    taxMinor: l.taxMinor,
    taxRateBps: l.taxRateBps,
    dischargeStock: l.dischargeStock,
  };
}
