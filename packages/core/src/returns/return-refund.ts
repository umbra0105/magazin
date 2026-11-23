import { addQuantity, quantityFromTicks, vatFromGross } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import {
  buildPartialStorno,
  InvoiceDraftError,
  type StornoRequestLine,
  type StornoReturned,
  type StornoSourceLine,
} from "../invoicing/invoice-draft";
import { selectedInvoiceProvider } from "../invoicing/invoice-schedule";
import { lockOrder } from "../orders/order-service";
import { requestOrderRefund, type OrderRefundDeps } from "../payments/order-refund";
import {
  RETURN_SHIPPING_REASON_MAX,
  returnRefundKey,
  RETURN_REFUND_KEY_PREFIX,
} from "./return-constants";
import { ReturnError } from "./return-errors";
import { lockReturn } from "./return-transition";

/**
 * Rambursarea unui retur (decizia 2026-11-22, D1). Suma propusă = DOAR produsele returnate: pentru fiecare linie acceptată, cu
 * ACELAȘI calcul ca stornoul parțial din Faza 13 (`buildPartialStorno`: o singură rotunjire pe linie, half-up, prin `Money` și
 * `Quantity`; ultima bucată dintr-o linie ia restul exact), deci rambursarea și stornoul au aceleași linii și aceleași sume. Transportul NU se adaugă singur: adminul îl poate adăuga manual, cu motiv.
 *
 * Returul NU are logică proprie de bani: rambursarea efectivă trece prin `requestOrderRefund` (serviciul din Faza 10: aceleași
 * permisiuni, aceeași limită pentru rolul Suport, aceeași idempotență, aceeași trimitere către procesator). Returul devine
 * «rambursat» abia când rambursarea e CONFIRMATĂ (`settleReturnOnRefund`, apelat din `addOrderEvent`).
 */

export interface RefundLineProposal {
  returnItemId: string;
  orderLineId: string;
  sku: string;
  title: string;
  acceptedTicks: bigint;
  refundLineMinor: number;
}

export interface RefundProposal {
  lines: RefundLineProposal[];
  productsMinor: number;
  /** Cererea de storno corespunzătoare (aceleași linii). */
  stornoRequest: StornoRequestLine[];
}

/** Construiește propunerea pentru un retur inspectat; nu scrie nimic. Refuză cantități care nu se pot factura sau depășesc comanda. */
export async function buildRefundProposal(tx: Db, returnId: string): Promise<RefundProposal> {
  const ret = await tx.returnRequest.findUnique({
    where: { id: returnId },
    select: {
      orderId: true,
      items: {
        where: { acceptedQty: { gt: 0n } },
        select: { id: true, orderLineId: true, acceptedQty: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!ret) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
  if (ret.items.length === 0) {
    throw new ReturnError(
      "RETURN_REFUND_INVALID",
      "Nicio bucată nu a fost acceptată la inspecție: nu există nimic de rambursat",
    );
  }
  const orderLines = await tx.orderLine.findMany({
    where: { orderId: ret.orderId },
    select: {
      id: true,
      sku: true,
      title: true,
      unitSymbol: true,
      quantity: true,
      unitPriceMinor: true,
      lineTotalMinor: true,
      taxMinor: true,
      taxRateBps: true,
    },
  });
  const source: StornoSourceLine[] = orderLines.map((l) => ({
    orderLineId: l.id,
    sku: l.sku,
    title: l.title,
    unitName: l.unitSymbol,
    quantityTicks: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: l.lineTotalMinor,
    taxMinor: l.taxMinor,
    taxRateBps: l.taxRateBps,
  }));
  // ce s-a rambursat deja din aceleași linii, prin ALTE retururi încheiate ale comenzii
  const earlier = await tx.returnItem.findMany({
    where: {
      return: { orderId: ret.orderId, status: "refunded", NOT: { id: returnId } },
      refundLineMinor: { not: null },
      acceptedQty: { gt: 0n },
    },
    select: { orderLineId: true, acceptedQty: true, refundLineMinor: true },
  });
  const returned = new Map<string, StornoReturned>();
  for (const e of earlier) {
    const line = orderLines.find((l) => l.id === e.orderLineId);
    if (!line || e.acceptedQty === null || e.refundLineMinor === null) continue;
    const prev = returned.get(e.orderLineId) ?? {
      quantityTicks: 0n,
      lineTotalMinor: 0,
      taxMinor: 0,
    };
    returned.set(e.orderLineId, {
      quantityTicks: addQuantity(
        quantityFromTicks(prev.quantityTicks),
        quantityFromTicks(e.acceptedQty),
      ),
      lineTotalMinor: prev.lineTotalMinor + e.refundLineMinor,
      taxMinor: prev.taxMinor + vatFromGross(e.refundLineMinor, line.taxRateBps),
    });
  }
  const stornoRequest: StornoRequestLine[] = ret.items.map((i) => ({
    orderLineId: i.orderLineId,
    quantityTicks: quantityFromTicks(i.acceptedQty ?? 0n),
  }));
  let storno;
  try {
    storno = buildPartialStorno(source, returned, stornoRequest);
  } catch (error) {
    if (error instanceof InvoiceDraftError) {
      throw new ReturnError("RETURN_REFUND_INVALID", error.message, { code: error.code });
    }
    throw error;
  }
  const lines: RefundLineProposal[] = ret.items.map((item) => {
    const doc = storno.lines.find((l) => l.orderLineId === item.orderLineId);
    if (!doc) throw new ReturnError("RETURN_REFUND_INVALID", "Linia nu apare în propunere");
    return {
      returnItemId: item.id,
      orderLineId: item.orderLineId,
      sku: doc.sku ?? "",
      title: doc.title,
      acceptedTicks: item.acceptedQty ?? 0n,
      refundLineMinor: doc.lineTotalMinor,
    };
  });
  return { lines, productsMinor: storno.totalMinor, stornoRequest };
}

export interface RefundReturnInput {
  returnId: string;
  actorLabel: string;
  /** `true` dacă actorul are `payments.refund` (fără limită de rambursare). */
  actorUnlimited: boolean;
  /** Transport rambursat manual, cu motiv (opțional). */
  shippingMinor?: number;
  shippingReason?: string;
}

export interface RefundReturnResult {
  refundId: string;
  created: boolean;
  amountMinor: number;
  productsMinor: number;
  shippingMinor: number;
}

/** Cheia rambursării curente a unui retur: `return:<id>` la prima încercare, `return:<id>:N` după una eșuată. */
async function currentRefundKey(
  tx: Db,
  returnId: string,
): Promise<{ key: string; existing: boolean }> {
  const base = returnRefundKey(returnId);
  const prior = await tx.refund.findMany({
    where: { idempotencyKey: { startsWith: base } },
    orderBy: { createdAt: "asc" },
    select: { idempotencyKey: true, status: true },
  });
  const last = prior.at(-1);
  if (!last) return { key: base, existing: false };
  if (last.status === "failed") return { key: `${base}:${prior.length + 1}`, existing: false };
  return { key: last.idempotencyKey, existing: true };
}

export async function refundReturn(
  deps: OrderRefundDeps,
  input: RefundReturnInput,
): Promise<RefundReturnResult> {
  const shippingMinor = input.shippingMinor ?? 0;
  const shippingReason = (input.shippingReason ?? "").trim();
  if (!Number.isSafeInteger(shippingMinor) || shippingMinor < 0) {
    throw new ReturnError("RETURN_REFUND_INVALID", "Transportul rambursat nu poate fi negativ");
  }
  if (
    shippingMinor > 0 &&
    (shippingReason === "" || shippingReason.length > RETURN_SHIPPING_REASON_MAX)
  ) {
    throw new ReturnError(
      "RETURN_REFUND_INVALID",
      `Transportul rambursat cere un motiv (cel mult ${RETURN_SHIPPING_REASON_MAX} de caractere)`,
    );
  }
  const head = await deps.db.returnRequest.findUnique({
    where: { id: input.returnId },
    select: { orderId: true, number: true },
  });
  if (!head) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");

  const prepared = await inTx(deps.db, async (tx) => {
    // ordinea blocărilor ca în serviciul de rambursări: comanda, apoi returul
    await lockOrder(tx, head.orderId);
    const locked = await lockReturn(tx, input.returnId);
    if (!locked) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
    if (locked.status !== "inspected") {
      throw new ReturnError("RETURN_STATE_INVALID", "Rambursarea se face după inspecție", {
        status: locked.status,
      });
    }
    const { key, existing } = await currentRefundKey(tx, input.returnId);
    if (existing) {
      // cerere repetată (dublu-click): sumele rămân cele deja stabilite
      const row = await tx.returnRequest.findUniqueOrThrow({
        where: { id: input.returnId },
        select: { refundProductsMinor: true, refundShippingMinor: true },
      });
      const stored = await tx.refund.findUniqueOrThrow({
        where: { idempotencyKey: key },
        select: { amountMinor: true },
      });
      return {
        key,
        amountMinor: stored.amountMinor,
        productsMinor: row.refundProductsMinor ?? 0,
        shippingMinor: row.refundShippingMinor,
      };
    }
    // o singură rambursare de retur în așteptare pe comandă: stornourile se emit în ordine, ca sumele să rămână exacte
    const pending = await tx.refund.count({
      where: {
        orderId: head.orderId,
        idempotencyKey: { startsWith: RETURN_REFUND_KEY_PREFIX },
        status: { in: ["requested", "manual_required"] },
        NOT: { idempotencyKey: { startsWith: returnRefundKey(input.returnId) } },
      },
    });
    if (pending > 0) {
      throw new ReturnError(
        "RETURN_REFUND_PENDING_OTHER",
        "Comanda are o altă rambursare de retur în așteptare: încheie-o înainte",
      );
    }
    const proposal = await buildRefundProposal(tx, input.returnId);
    const order = await tx.order.findUniqueOrThrow({
      where: { id: head.orderId },
      select: { shippingMinor: true },
    });
    if (shippingMinor > order.shippingMinor) {
      throw new ReturnError(
        "RETURN_REFUND_INVALID",
        "Transportul rambursat nu poate depăși transportul plătit la comandă",
      );
    }
    const amountMinor = proposal.productsMinor + shippingMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new ReturnError("RETURN_REFUND_INVALID", "Suma de rambursat trebuie să fie pozitivă");
    }
    // facturare activă: stornoul se poate emite doar peste o factură emisă (altfel nu există linii de verificat la ban)
    const provider = await selectedInvoiceProvider(tx);
    if (provider) {
      const invoice = await tx.invoice.findUnique({
        where: { orderId_docKey: { orderId: head.orderId, docKey: "invoice" } },
        select: { status: true },
      });
      if (!invoice || invoice.status !== "issued") {
        throw new ReturnError(
          "RETURN_REFUND_INVOICE_PENDING",
          "Factura comenzii nu e emisă: emite-o înainte de rambursare",
        );
      }
      // rambursarea care ar completa suma plătită ar declanșa un storno TOTAL (Faza 13) peste stornourile parțiale deja emise
      const payment = await tx.payment.findFirst({
        where: { orderId: head.orderId, status: { in: ["paid", "refunded"] } },
        orderBy: [{ capturedAt: "asc" }, { attemptNo: "asc" }],
        select: { amountMinor: true, refundCommittedMinor: true },
      });
      if (payment && payment.refundCommittedMinor + amountMinor >= payment.amountMinor) {
        const partials = await tx.invoice.count({
          where: {
            orderId: head.orderId,
            kind: "storno",
            status: { not: "skipped" },
            NOT: { docKey: { in: ["storno:total", "storno:proforma"] } },
          },
        });
        if (partials > 0) {
          throw new ReturnError(
            "RETURN_REFUND_COMPLETES_ORDER",
            "Rambursarea ar acoperi întreaga sumă plătită după stornouri parțiale: cazul cere o decizie contabilă",
          );
        }
      }
    }
    for (const line of proposal.lines) {
      await tx.returnItem.update({
        where: { id: line.returnItemId },
        data: { refundLineMinor: line.refundLineMinor },
      });
    }
    await tx.returnRequest.update({
      where: { id: input.returnId },
      data: {
        refundProductsMinor: proposal.productsMinor,
        refundShippingMinor: shippingMinor,
        refundShippingReason: shippingMinor > 0 ? shippingReason : null,
      },
    });
    return { key, amountMinor, productsMinor: proposal.productsMinor, shippingMinor };
  });

  const result = await requestOrderRefund(deps, {
    orderId: head.orderId,
    amountMinor: prepared.amountMinor,
    reason: `Retur R-${head.number}`,
    idempotencyKey: prepared.key,
    actorLabel: input.actorLabel,
    actorUnlimited: input.actorUnlimited,
  });
  return {
    refundId: result.refundId,
    created: result.created,
    amountMinor: prepared.amountMinor,
    productsMinor: prepared.productsMinor,
    shippingMinor: prepared.shippingMinor,
  };
}
