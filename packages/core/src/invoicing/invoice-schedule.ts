import type { Db } from "../db-tx";
import { notifyAdmins, orderContext } from "../notifications/admin-notifications";
import { enqueueInvoiceAlertEmail } from "./invoice-alert";
import {
  InvoiceDraftError,
  buildRemainderStorno,
  type StornoEarlierLine,
  type StornoParentLine,
} from "./invoice-draft";
import {
  INVOICE_TRIGGER_EVENT_TYPES,
  invoiceActionsFor,
  type InvoiceAction,
  type InvoiceOrderFacts,
  type InvoicePaymentMethod,
} from "./invoice-rules";

/**
 * Outbox-ul facturării (Faza 13): se apelează din `addOrderEvent`, în aceeași tranzacție cu evenimentul comenzii. Scrie DOAR rânduri
 * `invoice` «în coadă» (cu jurnal); nicio factură nu se emite de aici, emiterea o face workerul, prin coadă, cu reîncercări. O
 * factură care eșuează NU blochează comanda. Unicitatea `(comandă, docKey)` din bază face ca același eveniment procesat de două ori
 * (sau două evenimente simultane de plată) să dea UN SINGUR document.
 *
 * Fără furnizor ales în `invoicing.provider`, nu se scrie nimic: comenzile apar în lista «confirmate fără factură», de unde adminul
 * poate cere emiterea. Comenzile de pe canale externe nu se facturează de aici.
 */
export const INVOICING_PROVIDER_SETTING = "invoicing.provider";

export const DOC_KEY_PROFORMA = "proforma";
export const DOC_KEY_INVOICE = "invoice";
export const DOC_KEY_STORNO_TOTAL = "storno:total";
export const DOC_KEY_STORNO_PROFORMA = "storno:proforma";

export interface ScheduleEvent {
  id: string;
  type: string;
}

/** Furnizorul de facturare ales în setări, sau `null` dacă facturarea automată e oprită. */
export async function selectedInvoiceProvider(tx: Db): Promise<"smartbill" | "demo" | null> {
  const row = await tx.setting.findUnique({ where: { key: INVOICING_PROVIDER_SETTING } });
  return row?.value === "smartbill" || row?.value === "demo" ? row.value : null;
}

export interface OrderInvoiceFacts extends InvoiceOrderFacts {
  totalMinor: number;
  taxMinor: number;
}

export async function loadInvoiceFacts(tx: Db, orderId: string): Promise<OrderInvoiceFacts | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      paymentMethod: true,
      paymentStatus: true,
      externalId: true,
      totalMinor: true,
      taxMinor: true,
      lines: { select: { stockState: true } },
    },
  });
  if (!order) return null;
  const method = order.paymentMethod;
  if (method !== "cod" && method !== "bank_transfer" && method !== "card") return null;
  return {
    paymentMethod: method as InvoicePaymentMethod,
    paymentStatus: order.paymentStatus,
    external: order.externalId !== null,
    hasOnOrderLine: order.lines.some((l) => l.stockState === "on_order"),
    totalMinor: order.totalMinor,
    taxMinor: order.taxMinor,
  };
}

async function logEvent(tx: Db, invoiceId: string, type: string, message: string, data?: object) {
  await tx.invoiceEvent.create({
    data: { invoiceId, type, message, ...(data ? { data: data as never } : {}) },
  });
}

/** Pune în coadă documentul de emis (idempotent). Întoarce id-ul rândului nou, sau `null` dacă exista deja. */
export async function queueIssue(
  tx: Db,
  orderId: string,
  kind: "proforma" | "invoice",
  facts: Pick<OrderInvoiceFacts, "totalMinor" | "taxMinor">,
  meta: { trigger: string; requestedBy?: string | null },
): Promise<string | null> {
  const docKey = kind === "proforma" ? DOC_KEY_PROFORMA : DOC_KEY_INVOICE;
  const created = await tx.invoice.createManyAndReturn({
    data: [
      {
        orderId,
        kind,
        docKey,
        totalMinor: facts.totalMinor,
        taxMinor: facts.taxMinor,
        ...(meta.requestedBy ? { requestedBy: meta.requestedBy } : {}),
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  const id = created[0]?.id ?? null;
  if (id)
    await logEvent(tx, id, "queued", "Documentul a fost pus în coadă", { trigger: meta.trigger });
  return id;
}

const REMAINDER_EVENT = "reverse_not_needed";
const REFUSED_EVENT = "storno_refused";

/** Un storno refuzat la punerea în coadă NU blochează comanda: eveniment pe factură și alertă în admin (clopoțel, email intern). */
async function refuseStorno(
  tx: Db,
  parent: { id: string; orderId: string },
  reason: string,
  meta: { trigger: string },
): Promise<void> {
  const already = await tx.invoiceEvent.count({
    where: { invoiceId: parent.id, type: REFUSED_EVENT },
  });
  if (already === 0) {
    await logEvent(tx, parent.id, REFUSED_EVENT, reason.slice(0, 300), { trigger: meta.trigger });
  }
  const order = await tx.order.findUnique({
    where: { id: parent.orderId },
    select: { number: true },
  });
  const created = await notifyAdmins(tx, {
    kind: "invoice_failed",
    title: "Stornoul nu s-a putut pune în coadă",
    context: orderContext(order?.number ?? "", "Stornourile depășesc factura"),
    href: `/admin/comenzi/${parent.orderId}`,
    permission: "invoices.read",
    dedupKey: `storno-refused:${parent.id}`,
  });
  if (created) {
    await enqueueInvoiceAlertEmail(tx, {
      invoiceId: parent.id,
      orderId: parent.orderId,
      reason: "Stornourile depășesc factura",
    });
  }
}

/**
 * Pune în coadă stornoul «total» al facturii (sau anularea proformei) unei comenzi. Întoarce id-ul rândului nou sau `null`.
 *
 * Stornoul total acoperă DOAR restul nestornat al facturii (mini-faza `storno-total`, 2026-11-23):
 *  - fără niciun storno parțial existent, comportamentul e cel dintotdeauna: același document `storno:total`, pe totalul și TVA-ul
 *    facturii, emis prin `reverseInvoice` (liniile se copiază la emitere);
 *  - cu stornouri parțiale (orice stare în afară de «sărit»: în coadă, în emitere, emise, eșuate), documentul acoperă restul pe linii
 *    (cantități și brut rămase, inclusiv transportul și taxa de ramburs nestornate), cu liniile scrise acum; se emite ca factură cu
 *    cantități negative. Brutul tuturor stornourilor = totalul facturii EXACT; TVA-ul restului e extras din brutul restului;
 *  - rest zero: niciun document, doar un eveniment pe factură (o singură dată);
 *  - date incoerente (stornouri peste factură): nimic nu se creează, comanda nu se blochează, alertă în admin.
 * Calculul și crearea documentului se fac în tranzacția apelantului, cu comanda și factura-părinte blocate (`FOR UPDATE`), ca un storno
 * parțial simultan (`queuePartialStorno`, același lacăt pe comandă) să nu poată depăși totalul.
 */
export async function queueReverse(
  tx: Db,
  orderId: string,
  meta: { trigger: string; requestedBy?: string | null },
): Promise<string | null> {
  await tx.$queryRaw`SELECT id FROM customer_order WHERE id = ${orderId} FOR UPDATE`;
  const docs = await tx.invoice.findMany({
    where: { orderId, kind: { in: ["invoice", "proforma"] }, status: { not: "skipped" } },
    select: { id: true, kind: true, status: true, totalMinor: true, taxMinor: true },
  });
  // documentele încă netrimise către furnizor (în coadă, fără nicio încercare) nu se mai emit: nu e nimic de stornat
  let pending = docs;
  for (const doc of docs) {
    if (doc.status !== "queued") continue;
    const skipped = await tx.invoice.updateMany({
      where: { id: doc.id, status: "queued", attempts: 0 },
      data: { status: "skipped", nextAttemptAt: null },
    });
    if (skipped.count === 1) {
      pending = pending.filter((d) => d.id !== doc.id);
      await logEvent(
        tx,
        doc.id,
        "skipped",
        "Comanda s-a anulat înainte de emitere: documentul nu se mai emite",
        {
          trigger: meta.trigger,
        },
      );
    }
  }
  const invoice = pending.find((d) => d.kind === "invoice");
  const proforma = pending.find((d) => d.kind === "proforma");
  const parent = invoice ?? proforma;
  if (!parent) return null;

  let totalMinor = parent.totalMinor;
  let taxMinor = parent.taxMinor;
  let remainderLines: ReturnType<typeof buildRemainderStorno>["lines"] = [];
  if (invoice) {
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${invoice.id} FOR UPDATE`;
    const total = await tx.invoice.findUnique({
      where: { orderId_docKey: { orderId, docKey: DOC_KEY_STORNO_TOTAL } },
      select: { id: true },
    });
    if (total) return null; // același storno cerut a doua oară: idempotent
    const earlier = await tx.invoice.findMany({
      where: {
        orderId,
        kind: "storno",
        parentId: invoice.id,
        docKey: { startsWith: "storno:", not: DOC_KEY_STORNO_TOTAL },
        status: { not: "skipped" },
      },
      select: { totalMinor: true, lines: true },
    });
    if (earlier.length > 0) {
      const full = await tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { lines: { orderBy: { position: "asc" } } },
      });
      try {
        const rest = buildRemainderStorno(
          full.lines.map((l): StornoParentLine => ({
            kind: l.kind as StornoParentLine["kind"],
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
          })),
          earlier.flatMap((e) =>
            e.lines.map((l): StornoEarlierLine => ({
              kind: l.kind,
              orderLineId: l.orderLineId,
              quantityTicks: l.quantityTicks,
              lineTotalMinor: l.lineTotalMinor,
              taxMinor: l.taxMinor,
            })),
          ),
        );
        const earlierHeaders = earlier.reduce((acc, e) => acc + e.totalMinor, 0);
        if (earlierHeaders + rest.totalMinor !== invoice.totalMinor) {
          throw new InvoiceDraftError(
            "INVOICE_STORNO_EXCEEDS_TOTAL",
            `Stornourile (${earlierHeaders} + ${rest.totalMinor} bani) nu se închid pe totalul facturii (${invoice.totalMinor} bani)`,
          );
        }
        if (rest.lines.length === 0) {
          const noted = await tx.invoiceEvent.count({
            where: { invoiceId: invoice.id, type: REMAINDER_EVENT },
          });
          if (noted === 0) {
            await logEvent(
              tx,
              invoice.id,
              REMAINDER_EVENT,
              "Factura e deja integral stornată prin stornouri parțiale: nu se mai creează un storno total",
              { trigger: meta.trigger },
            );
          }
          return null;
        }
        totalMinor = rest.totalMinor;
        taxMinor = rest.taxMinor;
        remainderLines = rest.lines;
      } catch (error) {
        if (!(error instanceof InvoiceDraftError)) throw error;
        await refuseStorno(tx, { id: invoice.id, orderId }, error.message, meta);
        return null;
      }
    }
  }
  const created = await tx.invoice.createManyAndReturn({
    data: [
      {
        orderId,
        kind: "storno",
        docKey: invoice ? DOC_KEY_STORNO_TOTAL : DOC_KEY_STORNO_PROFORMA,
        parentId: parent.id,
        totalMinor,
        taxMinor,
        ...(meta.requestedBy ? { requestedBy: meta.requestedBy } : {}),
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  const id = created[0]?.id ?? null;
  if (id) {
    if (remainderLines.length > 0) {
      await tx.invoiceLine.createMany({
        data: remainderLines.map((l, index) => ({
          invoiceId: id,
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
          dischargeStock: false,
        })),
      });
    }
    await logEvent(
      tx,
      id,
      "queued",
      invoice
        ? remainderLines.length > 0
          ? "Stornoul pe restul nestornat al facturii a fost pus în coadă"
          : "Stornoul total a fost pus în coadă"
        : "Anularea proformei a fost pusă în coadă",
      { trigger: meta.trigger },
    );
  }
  return id;
}

export async function scheduleOrderInvoices(
  tx: Db,
  orderId: string,
  event: ScheduleEvent,
): Promise<void> {
  if (!INVOICE_TRIGGER_EVENT_TYPES.includes(event.type)) return;
  if ((await selectedInvoiceProvider(tx)) === null) return;
  const facts = await loadInvoiceFacts(tx, orderId);
  if (!facts) return;
  const actions: InvoiceAction[] = invoiceActionsFor(event.type, facts);
  for (const action of actions) {
    if (action.action === "issue") {
      await queueIssue(tx, orderId, action.kind, facts, { trigger: event.type });
    } else {
      await queueReverse(tx, orderId, { trigger: event.type });
    }
  }
}
