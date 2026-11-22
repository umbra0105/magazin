import { quantityFromTicks } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { queuePartialStorno } from "../invoicing/partial-storno";
import { selectedInvoiceProvider } from "../invoicing/invoice-schedule";
import { notifyAdmins, orderContext } from "../notifications/admin-notifications";
import { RETURN_REFUND_KEY_PREFIX, type ReturnStornoState } from "./return-constants";
import { ReturnError } from "./return-errors";
import { addReturnEvent, lockReturn, transitionReturn } from "./return-transition";

/**
 * Încheierea unui retur la CONFIRMAREA rambursării lui (decizia 2026-11-22, D1). Se apelează din `addOrderEvent` pentru evenimentul
 * `payment.refunded`, în aceeași tranzacție cu confirmarea (comanda e blocată de serviciul de rambursări). Idempotentă: un retur
 * deja rambursat sau o rambursare care nu e de retur nu se ating.
 *
 * Face două lucruri: (1) returul trece în `refunded` prin state machine; (2) pune în coadă stornoul parțial al Fazei 13, pe ACELEAȘI
 * linii, și verifică la ban că totalul stornoului e egal cu suma produselor rambursate. O diferență NU se ascunde: stornoul nu se
 * emite (se anulează în savepoint), returul ia `stornoState = failed`, iar adminii cu `returns.manage` primesc o notificare.
 * Un eșec la storno nu întoarce rambursarea (banii s-au întors deja).
 */
export const RETURN_STORNO_REFERENCE_PREFIX = "ret-";

export const returnStornoReference = (number: number): string =>
  `${RETURN_STORNO_REFERENCE_PREFIX}${number}`;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

class StornoMismatch extends ReturnError {
  constructor(refundMinor: number, stornoMinor: number) {
    super(
      "RETURN_REFUND_INVALID",
      `Stornoul (${stornoMinor} bani) nu coincide cu rambursarea produselor (${refundMinor} bani)`,
      { refundMinor, stornoMinor },
    );
  }
}

export async function settleReturnOnRefund(
  tx: Db,
  orderId: string,
  event: { type: string; data?: unknown },
  now: Date = new Date(),
): Promise<void> {
  if (event.type !== "payment.refunded") return;
  const refundId = asRecord(event.data)["refundId"];
  if (typeof refundId !== "string") return;
  const refund = await tx.refund.findUnique({
    where: { id: refundId },
    select: { id: true, status: true, idempotencyKey: true, amountMinor: true },
  });
  if (!refund || refund.status !== "confirmed") return;
  if (!refund.idempotencyKey.startsWith(RETURN_REFUND_KEY_PREFIX)) return;
  const returnId = refund.idempotencyKey.slice(RETURN_REFUND_KEY_PREFIX.length).split(":")[0] ?? "";
  const locked = await lockReturn(tx, returnId);
  if (!locked || locked.orderId !== orderId || locked.status !== "inspected") return;

  const ret = await tx.returnRequest.findUniqueOrThrow({
    where: { id: returnId },
    select: {
      number: true,
      refundProductsMinor: true,
      refundShippingMinor: true,
      items: {
        where: { acceptedQty: { gt: 0n } },
        select: { orderLineId: true, acceptedQty: true },
        orderBy: { createdAt: "asc" },
      },
      order: { select: { number: true } },
    },
  });
  const productsMinor = ret.refundProductsMinor ?? 0;
  await transitionReturn(
    tx,
    returnId,
    "refunded",
    { refundId: refund.id, refundProductsMinor: productsMinor },
    {
      type: "return.refunded",
      message: "Rambursarea returului a fost făcută",
      data: { amountMinor: refund.amountMinor },
    },
    now,
  );

  let state: ReturnStornoState;
  let note: string | null = null;
  if (!(await selectedInvoiceProvider(tx))) {
    state = "not_needed";
  } else {
    const total = await tx.invoice.findUnique({
      where: { orderId_docKey: { orderId, docKey: "storno:total" } },
      select: { status: true },
    });
    if (total && total.status !== "skipped") {
      state = "covered_by_total";
    } else {
      const reference = returnStornoReference(ret.number);
      try {
        await inTx(tx, async (inner) => {
          await queuePartialStorno(
            inner,
            orderId,
            reference,
            ret.items.map((i) => ({
              orderLineId: i.orderLineId,
              quantityTicks: quantityFromTicks(i.acceptedQty ?? 0n),
            })),
            `retur R-${ret.number}`,
          );
          const doc = await inner.invoice.findUnique({
            where: { orderId_docKey: { orderId, docKey: `storno:${reference}` } },
            select: { totalMinor: true },
          });
          if (!doc || doc.totalMinor !== productsMinor) {
            throw new StornoMismatch(productsMinor, doc?.totalMinor ?? -1);
          }
        });
        state = "queued";
      } catch (error) {
        state = "failed";
        note = (error instanceof Error ? error.message : "Eroare necunoscută").slice(0, 300);
        await notifyAdmins(tx, {
          kind: "return_storno_failed",
          title: "Stornoul unui retur rambursat nu s-a putut pune în coadă",
          context: orderContext(ret.order.number, `Retur R-${ret.number}`),
          href: `/admin/comenzi/retururi/${returnId}`,
          permission: "returns.manage",
          dedupKey: `return-storno-failed:${returnId}`,
        });
      }
    }
  }
  await tx.returnRequest.update({
    where: { id: returnId },
    data: { stornoState: state, stornoNote: note },
  });
  await addReturnEvent(tx, returnId, {
    type: state === "failed" ? "return.storno_failed" : "return.storno_state",
    message:
      state === "queued"
        ? "Stornoul parțial a fost pus în coadă"
        : state === "covered_by_total"
          ? "Stornoul total al comenzii acoperă returul"
          : state === "not_needed"
            ? "Facturarea e oprită: niciun storno de emis"
            : "Stornoul parțial NU s-a putut pune în coadă: verifică în factură",
    data: { state },
  });
}
