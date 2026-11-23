import { deltaBetween, quantityFromTicks } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { StockError } from "../inventory/stock-errors";
import { StockService } from "../inventory/stock-service";
import { ReturnError } from "./return-errors";
import { addReturnEvent, lockReturn } from "./return-transition";

/**
 * Repunerea pe stoc a unui retur inspectat (decizia 2026-11-22): doar liniile marcate «revandabile» la inspecție, doar pentru
 * produse cu stoc gestionat, prin `StockService.adjustPhysical` (motiv «retur», mișcare imuabilă în registru). Produsele fără stoc
 * gestionat (`manageStock = false`) nu au NICIO acțiune de stoc.
 *
 * O SINGURĂ DATĂ pe linie, garantat în bază: linia se «revendică» cu `UPDATE … WHERE restockedAt IS NULL`; cine pierde cursa (dublu-click,
 * două cereri simultane) nu face nimic, iar marcajul nu se mai poate șterge (trigger). Marcajul și mișcarea de stoc stau în aceeași
 * tranzacție: dacă stocul refuză, marcajul se anulează.
 */
export interface RestockActor {
  id?: string;
  label: string;
}

export interface RestockResult {
  /** Liniile repuse acum pe stoc. */
  restocked: number;
  /** Liniile care nu au nicio acțiune de stoc (stoc negestionat sau variantă ștearsă). */
  notManaged: number;
  /** Liniile deja repuse înainte (idempotență). */
  alreadyRestocked: number;
  /** Liniile fără bucăți revandabile. */
  notResellable: number;
}

export async function restockReturn(
  db: Db,
  returnId: string,
  actor: RestockActor,
  now: Date,
): Promise<RestockResult> {
  return inTx(db, async (tx) => {
    const locked = await lockReturn(tx, returnId);
    if (!locked) throw new ReturnError("RETURN_NOT_FOUND", "Returul nu există");
    if (locked.status !== "inspected" && locked.status !== "refunded") {
      throw new ReturnError(
        "RETURN_RESTOCK_INVALID",
        "Repunerea pe stoc se face după inspecția returului",
        { status: locked.status },
      );
    }
    const ret = await tx.returnRequest.findUniqueOrThrow({
      where: { id: returnId },
      select: {
        number: true,
        items: {
          select: {
            id: true,
            acceptedQty: true,
            resellable: true,
            restockedAt: true,
            orderLine: { select: { variantId: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const result: RestockResult = {
      restocked: 0,
      notManaged: 0,
      alreadyRestocked: 0,
      notResellable: 0,
    };
    for (const item of ret.items) {
      if (item.restockedAt !== null) {
        result.alreadyRestocked += 1;
        continue;
      }
      if (item.resellable !== true || item.acceptedQty === null || item.acceptedQty <= 0n) {
        result.notResellable += 1;
        continue;
      }
      const variantId = item.orderLine.variantId;
      if (variantId === null) {
        result.notManaged += 1;
        continue;
      }
      try {
        // revendicarea liniei și mișcarea de stoc într-un singur savepoint: dacă stocul refuză, marcajul se anulează odată cu el
        const outcome = await inTx(tx, async (inner) => {
          const claimed = await inner.returnItem.updateMany({
            where: { id: item.id, restockedAt: null },
            data: { restockedAt: now },
          });
          if (claimed.count !== 1) return "already" as const;
          await new StockService({ db: inner, now: () => now }).adjustPhysical({
            variantId,
            delta: deltaBetween(quantityFromTicks(0n), quantityFromTicks(item.acceptedQty ?? 0n)),
            reason: "return",
            note: `Retur R-${ret.number}`,
            ...(actor.id ? { actor: { id: actor.id, label: actor.label } } : {}),
          });
          return "restocked" as const;
        });
        if (outcome === "restocked") result.restocked += 1;
        else result.alreadyRestocked += 1;
      } catch (error) {
        if (
          error instanceof StockError &&
          (error.code === "STOCK_NOT_MANAGED" || error.code === "STOCK_VARIANT_NOT_FOUND")
        ) {
          // fără stoc gestionat: nicio acțiune de stoc (marcajul s-a anulat cu savepoint-ul)
          result.notManaged += 1;
          continue;
        }
        throw error;
      }
    }
    if (result.restocked > 0) {
      await addReturnEvent(tx, returnId, {
        type: "return.restocked",
        message: `${result.restocked} ${result.restocked === 1 ? "linie repusă" : "linii repuse"} pe stoc`,
        actorLabel: actor.label,
        data: { ...result },
      });
    }
    return result;
  });
}
