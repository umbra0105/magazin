"use server";

import { z } from "zod";
import { CartError, type CartMutation, type CartView } from "@ecom/core";
import { getLogger, quantityFromTicks, type Quantity } from "@ecom/shared";
import {
  allowCartMutation,
  clearCartCookie,
  getCartService,
  resolveCartOwner,
  resolveOwnerForWrite,
  setCartCookie,
} from "@/lib/cart";
import { toCartDto, type CartDto } from "@/lib/cart-dto";
import { getStorefrontFormat } from "@/lib/storefront-catalog";

/**
 * Acțiunile coșului (Faza 8), apelate din interfață. Fiecare: validează intrarea cu Zod, aplică limita de modificări pe minut,
 * lasă serviciul (`CartService`) să valideze pasul, stocul și plafoanele PE SERVER și întoarce coșul gata formatat. Coșul NU
 * rezervă stoc. Nicio acțiune nu primește id de coș sau de linie: proprietarul vine din sesiune sau din cookie, linia se
 * alege după variantă. Câmpul pentru coduri de reducere nu există încă (vine în Faza 17).
 */

const variantId = z.string().min(1).max(64);
const ticks = z.string().regex(/^[0-9]{1,13}$/);

export type CartActionResult =
  { ok: true; cart: CartDto } | { ok: false; code: string; cart: CartDto | null };

async function dto(view: CartView): Promise<CartDto> {
  const format = await getStorefrontFormat();
  return toCartDto(view, format);
}

function quantityOf(text: string): Quantity | null {
  try {
    return quantityFromTicks(BigInt(text));
  } catch {
    return null;
  }
}

async function failure(code: string, view?: CartView): Promise<CartActionResult> {
  return { ok: false, code, cart: view ? await dto(view) : null };
}

/** Coșul curent (pentru sertar și pagină). Nu scrie nimic și nu atinge cookie-ul. */
export async function getCartAction(): Promise<CartDto> {
  const { owner } = await resolveCartOwner();
  return dto(await getCartService().view(owner));
}

/** Numărul de linii din coș (insigna din header). */
export async function getCartCountAction(): Promise<number> {
  const { owner } = await resolveCartOwner();
  return getCartService().lineCount(owner);
}

async function mutate(
  run: (owner: Awaited<ReturnType<typeof resolveOwnerForWrite>>["owner"]) => Promise<CartMutation>,
): Promise<CartActionResult> {
  if (!(await allowCartMutation())) return failure("rate_limited");
  const { owner } = await resolveOwnerForWrite();
  try {
    const result = await run(owner);
    if (result.newToken) await setCartCookie(result.newToken);
    return { ok: true, cart: await dto(result.view) };
  } catch (error) {
    if (error instanceof CartError) {
      return failure(error.rejection.reason, await getCartService().view(owner));
    }
    getLogger().error({ err: error }, "operația pe coș a eșuat");
    return failure("failed");
  }
}

/** Adaugă o variantă în coș; fără `quantityTicks` se adaugă cantitatea minimă comandabilă (adăugare directă, ex. piese de schimb). */
export async function addToCartAction(input: unknown): Promise<CartActionResult> {
  const parsed = z.object({ variantId, quantityTicks: ticks.optional() }).safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  const quantity =
    parsed.data.quantityTicks === undefined ? "minimum" : quantityOf(parsed.data.quantityTicks);
  if (!quantity) return failure("invalid_input");
  return mutate((owner) =>
    getCartService().add(owner, { variantId: parsed.data.variantId, quantity }),
  );
}

export async function setCartQuantityAction(input: unknown): Promise<CartActionResult> {
  const parsed = z.object({ variantId, quantityTicks: ticks }).safeParse(input);
  const quantity = parsed.success ? quantityOf(parsed.data.quantityTicks) : null;
  if (!parsed.success || !quantity) return failure("invalid_input");
  return mutate((owner) =>
    getCartService().setQuantity(owner, { variantId: parsed.data.variantId, quantity }),
  );
}

export async function removeCartLineAction(input: unknown): Promise<CartActionResult> {
  const parsed = z.object({ variantId }).safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  return mutate((owner) => getCartService().remove(owner, parsed.data.variantId));
}

export async function acknowledgeCartPriceAction(input: unknown): Promise<CartActionResult> {
  const parsed = z.object({ variantId }).safeParse(input);
  if (!parsed.success) return failure("invalid_input");
  return mutate((owner) => getCartService().acknowledgePrice(owner, parsed.data.variantId));
}

/**
 * Apelată de formularul de autentificare după un login reușit: îmbină coșul de oaspete (din cookie) în coșul utilizatorului și
 * șterge cookie-ul. Fără sesiune sau fără cookie nu face nimic (idempotentă).
 */
export async function mergeGuestCartAction(): Promise<{ merged: number }> {
  const resolved = await resolveCartOwner();
  if (resolved.owner.kind !== "user" || !resolved.guestToken) return { merged: 0 };
  const result = await getCartService().mergeGuestIntoUser(
    resolved.guestToken,
    resolved.owner.userId,
  );
  await clearCartCookie();
  return { merged: result.merged };
}
