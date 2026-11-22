import type { Db } from "../db-tx";
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

/** Pune în coadă stornoul total al facturii (sau anularea proformei) unei comenzi. Întoarce id-ul rândului nou sau `null`. */
export async function queueReverse(
  tx: Db,
  orderId: string,
  meta: { trigger: string; requestedBy?: string | null },
): Promise<string | null> {
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
  const created = await tx.invoice.createManyAndReturn({
    data: [
      {
        orderId,
        kind: "storno",
        docKey: invoice ? DOC_KEY_STORNO_TOTAL : DOC_KEY_STORNO_PROFORMA,
        parentId: parent.id,
        totalMinor: parent.totalMinor,
        taxMinor: parent.taxMinor,
        ...(meta.requestedBy ? { requestedBy: meta.requestedBy } : {}),
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  const id = created[0]?.id ?? null;
  if (id) {
    await logEvent(
      tx,
      id,
      "queued",
      invoice ? "Stornoul total a fost pus în coadă" : "Anularea proformei a fost pusă în coadă",
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
