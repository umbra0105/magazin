import { formatQuantity, quantityFromTicks } from "@ecom/shared";
import type { Db } from "../db-tx";
import { buildDigitalExport } from "../digital/digital-privacy";
import { ownedOrdersWhere, type AccountUser } from "./order-ownership";

/**
 * Exportul GDPR al contului (Faza 14): un obiect JSON cu datele clientului. Câmpurile se aleg EXPLICIT (lista albă, niciodată un
 * rând întreg): fără note interne (`adminNote`, `supplier*`, `OrderNote`, notele de retur), fără costul de achiziție, fără IP și
 * user-agent, fără datele brute ale plăților, fără evenimente interne. Sumele sunt în bani (întregi), cantitățile ca text exact.
 * Cuprinde comenzile clientului stabilite după regula de proprietate (inclusiv cele de oaspete cu emailul lui verificat).
 */
export const ACCOUNT_EXPORT_VERSION = 1;

export async function buildAccountExport(
  db: Db,
  user: AccountUser,
  now: Date,
): Promise<Record<string, unknown>> {
  const account = await db.user.findUnique({
    where: { id: user.id },
    select: {
      name: true,
      email: true,
      emailVerified: true,
      createdAt: true,
      preference: {
        select: {
          phone: true,
          marketingOptIn: true,
          marketingDecisionAt: true,
          marketingDecisionText: true,
        },
      },
    },
  });
  const addresses = await db.customerAddress.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      label: true,
      fullName: true,
      company: true,
      vatId: true,
      tradeRegisterNo: true,
      phone: true,
      countyName: true,
      localityName: true,
      street: true,
      postalCode: true,
      country: true,
      isDefaultShipping: true,
      isDefaultBilling: true,
    },
  });
  const wishlist = await db.wishlistItem.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      variant: { select: { sku: true, product: { select: { title: true } } } },
    },
  });
  const orders = await db.order.findMany({
    where: ownedOrdersWhere(user),
    orderBy: { placedAt: "asc" },
    select: {
      number: true,
      placedAt: true,
      status: true,
      paymentStatus: true,
      fulfillmentStatus: true,
      paymentMethod: true,
      currency: true,
      subtotalMinor: true,
      discountMinor: true,
      shippingMinor: true,
      codFeeMinor: true,
      taxMinor: true,
      totalMinor: true,
      customerNote: true,
      lines: {
        orderBy: { createdAt: "asc" },
        select: {
          sku: true,
          title: true,
          variantTitle: true,
          quantity: true,
          unitSymbol: true,
          unitPriceMinor: true,
          lineTotalMinor: true,
          taxMinor: true,
          taxRateBps: true,
        },
      },
      addresses: {
        select: {
          kind: true,
          fullName: true,
          company: true,
          vatId: true,
          phone: true,
          street: true,
          postalCode: true,
          localityName: true,
          countyName: true,
          country: true,
        },
      },
      shipments: {
        where: { kind: "outbound" },
        select: { carrier: true, awb: true, status: true, deliveredAt: true },
      },
      invoices: {
        where: { status: "issued" },
        select: { kind: true, series: true, number: true, issuedAt: true, totalMinor: true },
      },
    },
  });
  const returns = await db.returnRequest.findMany({
    where: { userId: user.id },
    orderBy: { requestedAt: "asc" },
    select: {
      number: true,
      status: true,
      requestedAt: true,
      customerNote: true,
      rejectReason: true,
      returnCarrier: true,
      returnAwb: true,
      refundProductsMinor: true,
      refundShippingMinor: true,
      order: { select: { number: true } },
      items: {
        select: {
          requestedQty: true,
          acceptedQty: true,
          reasonCode: true,
          reasonText: true,
          condition: true,
          orderLine: { select: { sku: true, title: true } },
        },
      },
    },
  });
  const digital = await buildDigitalExport(db, user.id);
  const qty = (ticks: bigint | null): string | null =>
    ticks === null ? null : formatQuantity(quantityFromTicks(ticks));
  return {
    version: ACCOUNT_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    account: {
      name: account?.name ?? null,
      email: account?.email ?? null,
      emailVerified: account?.emailVerified ?? false,
      createdAt: account?.createdAt.toISOString() ?? null,
      phone: account?.preference?.phone ?? null,
    },
    preferences: {
      serviceEmails: "mereu active (emailuri despre comenzi)",
      marketingOptIn: account?.preference?.marketingOptIn ?? false,
      marketingDecisionAt: account?.preference?.marketingDecisionAt?.toISOString() ?? null,
      marketingDecisionText: account?.preference?.marketingDecisionText ?? null,
    },
    addresses,
    wishlist: wishlist.map((w) => ({
      sku: w.variant.sku,
      title: w.variant.product.title,
      addedAt: w.createdAt.toISOString(),
    })),
    orders: orders.map((o) => ({
      number: o.number,
      placedAt: o.placedAt.toISOString(),
      status: o.status,
      paymentStatus: o.paymentStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      paymentMethod: o.paymentMethod,
      currency: o.currency,
      totals: {
        subtotalMinor: o.subtotalMinor,
        discountMinor: o.discountMinor,
        shippingMinor: o.shippingMinor,
        codFeeMinor: o.codFeeMinor,
        taxMinor: o.taxMinor,
        totalMinor: o.totalMinor,
      },
      customerNote: o.customerNote,
      lines: o.lines.map((l) => ({
        sku: l.sku,
        title: l.title,
        variantTitle: l.variantTitle,
        quantity: qty(l.quantity),
        unit: l.unitSymbol,
        unitPriceMinor: l.unitPriceMinor,
        lineTotalMinor: l.lineTotalMinor,
        taxMinor: l.taxMinor,
        taxRateBps: l.taxRateBps,
      })),
      addresses: o.addresses,
      shipments: o.shipments.map((s) => ({
        carrier: s.carrier,
        awb: s.awb,
        status: s.status,
        deliveredAt: s.deliveredAt?.toISOString() ?? null,
      })),
      invoices: o.invoices.map((i) => ({
        kind: i.kind,
        series: i.series,
        number: i.number,
        issuedAt: i.issuedAt?.toISOString() ?? null,
        totalMinor: i.totalMinor,
      })),
    })),
    returns: returns.map((r) => ({
      number: r.number,
      order: r.order.number,
      status: r.status,
      requestedAt: r.requestedAt.toISOString(),
      customerNote: r.customerNote,
      rejectReason: r.rejectReason,
      returnCarrier: r.returnCarrier,
      returnAwb: r.returnAwb,
      refundProductsMinor: r.refundProductsMinor,
      refundShippingMinor: r.refundShippingMinor,
      items: r.items.map((i) => ({
        sku: i.orderLine.sku,
        title: i.orderLine.title,
        requested: qty(i.requestedQty),
        accepted: qty(i.acceptedQty),
        reasonCode: i.reasonCode,
        reasonText: i.reasonText,
        condition: i.condition,
      })),
    })),
    // achizițiile digitale și accesările proprii (Faza 14b): fără cheie de stocare, jeton, IP sau user-agent
    digitalPurchases: digital.purchases,
  };
}
