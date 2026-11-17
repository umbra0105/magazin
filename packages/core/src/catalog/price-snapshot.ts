import type { Prisma, PrismaClient } from "@ecom/db";
import { planPricePoints } from "./price-points";

type Db = PrismaClient | Prisma.TransactionClient;

export interface PriceSnapshotResult {
  /** Variantele verificate. */
  variants: number;
  /** Punctele noi scrise în `PriceHistory`. */
  written: number;
}

/** Câte variante se citesc dintr-o dată (memorie și interogări de dimensiune fixă). */
const BATCH = 500;

/**
 * Jobul zilnic al istoricului de preț (C-18, Omnibus): pentru FIECARE variantă a produselor nesterse scrie în `PriceHistory` ce s-a
 * schimbat de la ultimul punct (vezi `planPricePoints`: tranzițiile programate la momentul lor exact; prima observație la momentul
 * rulării, fără istoric inventat). Idempotent (a doua rulare nu scrie nimic), sigur la rulări simultane (cheia unică
 * `(variantId, effectiveFrom)` + `skipDuplicates`) și nu citește costul (doar câmpurile de preț public).
 */
export async function snapshotPriceHistory(db: Db, now: Date): Promise<PriceSnapshotResult> {
  let variants = 0;
  let written = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await db.productVariant.findMany({
      where: { product: { deletedAt: null } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        price: true,
        salePrice: true,
        saleStartsAt: true,
        saleEndsAt: true,
        priceHistory: {
          orderBy: { effectiveFrom: "desc" },
          take: 1,
          select: { price: true, effectiveFrom: true },
        },
      },
    });
    if (batch.length === 0) break;
    const rows = batch.flatMap((variant) =>
      planPricePoints(variant, variant.priceHistory[0] ?? null, now).map((point) => ({
        variantId: variant.id,
        price: point.price,
        effectiveFrom: point.effectiveFrom,
      })),
    );
    if (rows.length > 0) {
      const created = await db.priceHistory.createMany({ data: rows, skipDuplicates: true });
      written += created.count;
    }
    variants += batch.length;
    cursor = batch[batch.length - 1]?.id;
    if (batch.length < BATCH) break;
  }
  return { variants, written };
}
