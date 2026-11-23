import { quantityFromTicks, sumQuantities, type Quantity } from "@ecom/shared";
import type { Db } from "../db-tx";
import { effectiveSaleStep } from "../inventory/sale-config";
import { activeReturnQuantity, returnableQuantity } from "./return-eligibility";
import type { ReturnStatus } from "./return-constants";

/**
 * Liniile unei comenzi cu ce a rămas returnabil din fiecare. Citire fără blocare (pentru ecran și validare); garanția că suma
 * cantităților nu depășește comanda e în bază (trigger cu blocarea liniei). Niciun preț de achiziție și nimic intern.
 */
export interface ReturnableLine {
  orderLineId: string;
  sku: string;
  title: string;
  variantTitle: string | null;
  imageUrl: string | null;
  unitSymbol: string;
  unitDecimals: number;
  ordered: Quantity;
  /** Cantitatea care ocupă linia în retururile active. */
  inReturns: Quantity;
  returnable: Quantity;
  /** Pasul de vânzare: cantitatea returnată e multiplu exact al lui. */
  step: Quantity;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export async function loadReturnableLines(db: Db, orderId: string): Promise<ReturnableLine[]> {
  const lines = await db.orderLine.findMany({
    // liniile digitale nu se returnează din cont (Faza 14b, D6): nu apar în listă, iar cererea cu ele e respinsă ca «nu face parte din
    // comandă»; accesul se retrage de admin, prin rambursarea liniei
    where: { orderId, isDigital: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      sku: true,
      title: true,
      variantTitle: true,
      imageUrl: true,
      unitSymbol: true,
      unitDecimals: true,
      quantity: true,
      unitPriceMinor: true,
      lineTotalMinor: true,
      variant: { select: { saleStep: true, product: { select: { saleStep: true } } } },
    },
  });
  if (lines.length === 0) return [];
  const items = await db.returnItem.findMany({
    where: { orderLineId: { in: lines.map((l) => l.id) } },
    select: {
      orderLineId: true,
      requestedQty: true,
      acceptedQty: true,
      return: { select: { status: true } },
    },
  });
  return lines.map((line) => {
    const active = sumQuantities(
      items
        .filter((i) => i.orderLineId === line.id)
        .map((i) =>
          activeReturnQuantity(
            i.return.status as ReturnStatus,
            quantityFromTicks(i.requestedQty),
            i.acceptedQty === null ? null : quantityFromTicks(i.acceptedQty),
          ),
        ),
    );
    const ordered = quantityFromTicks(line.quantity);
    return {
      orderLineId: line.id,
      sku: line.sku,
      title: line.title,
      variantTitle: line.variantTitle,
      imageUrl: line.imageUrl,
      unitSymbol: line.unitSymbol,
      unitDecimals: line.unitDecimals,
      ordered,
      inReturns: active,
      returnable: returnableQuantity(ordered, active),
      step: quantityFromTicks(
        effectiveSaleStep(line.variant?.saleStep, line.variant?.product.saleStep),
      ),
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
    };
  });
}
