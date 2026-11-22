import type { Db } from "../db-tx";
import { AccountError } from "./account-errors";

/**
 * Wishlist-ul clientului (Faza 14, în spatele flag-ului `wishlist`: apelantul verifică flag-ul înaintea oricărui apel). O variantă o
 * singură dată pe client (unic în bază); operațiile lucrează DOAR pe rândurile clientului autentificat. Prețurile NU se calculează
 * aici: pagina `/cont/favorite` le ia din motorul de prețuri, ca orice alt ecran; nimic din costul de achiziție nu trece pe aici.
 */
export const WISHLIST_LIMIT = 200;

export interface WishlistEntry {
  variantId: string;
  addedAt: Date;
}

export async function listWishlist(db: Db, userId: string): Promise<WishlistEntry[]> {
  const rows = await db.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { variantId: true, createdAt: true },
  });
  return rows.map((r) => ({ variantId: r.variantId, addedAt: r.createdAt }));
}

export async function wishlistVariantIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.wishlistItem.findMany({ where: { userId }, select: { variantId: true } });
  return rows.map((r) => r.variantId);
}

/** Adaugă o variantă (idempotent). Doar variante ale produselor active, vizibile în magazin. */
export async function addToWishlist(db: Db, userId: string, variantId: string): Promise<void> {
  const variant = await db.productVariant.findFirst({
    where: { id: variantId, product: { status: "active", deletedAt: null } },
    select: { id: true },
  });
  if (!variant) {
    throw new AccountError("WISHLIST_VARIANT_NOT_FOUND", "Produsul nu mai este disponibil");
  }
  const existing = await db.wishlistItem.findUnique({
    where: { userId_variantId: { userId, variantId } },
    select: { id: true },
  });
  if (existing) return;
  if ((await db.wishlistItem.count({ where: { userId } })) >= WISHLIST_LIMIT) {
    throw new AccountError(
      "WISHLIST_LIMIT",
      `Lista de favorite are cel mult ${WISHLIST_LIMIT} de produse`,
    );
  }
  await db.wishlistItem.createMany({ data: [{ userId, variantId }], skipDuplicates: true });
}

export async function removeFromWishlist(db: Db, userId: string, variantId: string): Promise<void> {
  await db.wishlistItem.deleteMany({ where: { userId, variantId } });
}

/** Variantele din favorite cu produsul lor (id și titlu), în ordinea adăugării (cele mai noi primele): pentru pagina «Favorite». */
export async function listWishlistProducts(
  db: Db,
  userId: string,
): Promise<Array<{ variantId: string; productId: string; title: string }>> {
  const rows = await db.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      variantId: true,
      variant: { select: { productId: true, product: { select: { title: true } } } },
    },
  });
  return rows.map((r) => ({
    variantId: r.variantId,
    productId: r.variant.productId,
    title: r.variant.product.title,
  }));
}
