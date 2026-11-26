import { inTx, type Db } from "../db-tx";
import { addOrderEvent } from "../orders/order-service";
import {
  buildPartialStorno,
  type StornoRequestLine,
  type StornoReturned,
  type StornoSourceLine,
} from "./invoice-draft";
import { InvoiceServiceError } from "./invoice-service-error";

/**
 * Storno PARȚIAL pe produse (retur parțial), mutat din `InvoiceService.requestPartialStorno` fără nicio schimbare de logică, ca să
 * poată fi apelat și din tranzacția care confirmă rambursarea unui retur (Faza 14). `reference` identifică returul (unic pe comandă:
 * aceeași cerere repetată nu emite al doilea document). Transportul NU se stornează automat (decizia 2026-11-22; întrebarea #11 din
 * INTREBARI-CONTABIL, 🟡).
 */
export async function queuePartialStorno(
  db: Db,
  orderId: string,
  reference: string,
  returns: readonly StornoRequestLine[],
  actorLabel: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(reference)) {
    throw new InvoiceServiceError("INVOICE_STATE_INVALID", "Referința returului nu e validă");
  }
  return inTx(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM customer_order WHERE id = ${orderId} FOR UPDATE`;
    const parent = await tx.invoice.findUnique({
      where: { orderId_docKey: { orderId, docKey: "invoice" } },
      include: { lines: true },
    });
    if (!parent || parent.status !== "issued") {
      throw new InvoiceServiceError(
        "INVOICE_STATE_INVALID",
        "Comanda nu are o factură emisă de stornat",
      );
    }
    const total = await tx.invoice.findUnique({
      where: { orderId_docKey: { orderId, docKey: "storno:total" } },
      select: { status: true },
    });
    if (total && total.status !== "skipped") {
      throw new InvoiceServiceError("INVOICE_STATE_INVALID", "Factura a fost deja stornată total");
    }
    const earlier = await tx.invoice.findMany({
      where: {
        orderId,
        kind: "storno",
        docKey: { startsWith: "storno:" },
        parentId: parent.id,
        status: { not: "skipped" },
      },
      include: { lines: true },
    });
    const returned = new Map<string, StornoReturned>();
    for (const s of earlier) {
      for (const l of s.lines) {
        // cantitatea și brutul stornate se numără din rândurile de PRODUS; rândul de reducere se deduce din ele
        if (!l.orderLineId || l.kind !== "product") continue;
        const prev = returned.get(l.orderLineId) ?? {
          quantityTicks: 0n,
          lineTotalMinor: 0,
          taxMinor: 0,
        };
        returned.set(l.orderLineId, {
          quantityTicks: prev.quantityTicks + l.quantityTicks,
          lineTotalMinor: prev.lineTotalMinor + l.lineTotalMinor,
          taxMinor: prev.taxMinor + l.taxMinor,
        });
      }
    }
    const source: StornoSourceLine[] = parent.lines
      .filter((l) => l.kind === "product" && l.orderLineId !== null)
      .map((l) => {
        const discount = parent.lines.find(
          (d) => d.kind === "discount" && d.orderLineId === l.orderLineId,
        );
        return {
          orderLineId: l.orderLineId as string,
          sku: l.sku as string,
          title: l.title,
          unitName: l.unitName,
          quantityTicks: l.quantityTicks,
          unitPriceMinor: l.unitPriceMinor,
          lineTotalMinor: l.lineTotalMinor,
          taxMinor: l.taxMinor,
          taxRateBps: l.taxRateBps,
          ...(discount
            ? {
                discountMinor: discount.lineTotalMinor,
                discountTitle: discount.title,
                discountUnitName: discount.unitName,
              }
            : {}),
        };
      });
    const storno = buildPartialStorno(source, returned, returns);
    // apărare în plus: suma stornourilor (brut) nu depășește niciodată totalul facturii
    const earlierMinor = earlier.reduce((acc, s) => acc + s.totalMinor, 0);
    if (earlierMinor + storno.totalMinor > parent.totalMinor) {
      throw new InvoiceServiceError(
        "INVOICE_STORNO_EXCEEDS_TOTAL",
        "Stornoul ar duce suma stornată peste totalul facturii",
      );
    }
    const created = await tx.invoice.createManyAndReturn({
      data: [
        {
          orderId,
          kind: "storno",
          docKey: `storno:${reference}`,
          parentId: parent.id,
          totalMinor: storno.totalMinor,
          taxMinor: storno.taxMinor,
          requestedBy: actorLabel,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    const id = created[0]?.id ?? null;
    if (!id) return null;
    await tx.invoiceLine.createMany({
      data: storno.lines.map((l, index) => ({
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
    await tx.invoiceEvent.create({
      data: {
        invoiceId: id,
        type: "queued",
        message: "Stornoul parțial a fost pus în coadă",
        data: { reference },
      },
    });
    await addOrderEvent(tx, orderId, {
      type: "invoice.partial_storno_requested",
      message: `Stornoul parțial a fost cerut de ${actorLabel} (în coadă)`,
      actorLabel,
      data: { invoiceId: id, reference },
    });
    return id;
  });
}
