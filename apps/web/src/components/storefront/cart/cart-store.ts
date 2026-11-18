"use client";

import { useSyncExternalStore } from "react";
import {
  acknowledgeCartPriceAction,
  addToCartAction,
  getCartAction,
  getCartCountAction,
  removeCartLineAction,
  setCartQuantityAction,
  type CartActionResult,
} from "@/app/(storefront)/cos/actions";
import type { CartDto } from "@/lib/cart-dto";
import { getMessages } from "@/messages";

/**
 * Starea coșului în browser: UN singur exemplar pentru header (insignă), sertar, pagina `/cos` și butoanele «Adaugă în coș».
 * Nu calculează nimic: păstrează ultimul coș primit de la server (gata formatat) și anunță, într-o regiune `aria-live`, rezultatul
 * fiecărei acțiuni. Fiecare modificare trece prin server actions, care validează pasul, stocul și plafoanele pe server.
 */

const m = () => getMessages().storefront.cart;

export interface CartMessage {
  kind: "status" | "error";
  text: string;
  /** Numărul acțiunii, ca același text repetat să fie anunțat din nou. */
  id: number;
}

export interface CartState {
  cart: CartDto | null;
  /** Numărul de linii cunoscut (din coș sau din insigna încărcată la pornire). */
  count: number | null;
  loading: boolean;
  loadFailed: boolean;
  busy: boolean;
  drawerOpen: boolean;
  message: CartMessage | null;
}

let state: CartState = {
  cart: null,
  count: null,
  loading: false,
  loadFailed: false,
  busy: false,
  drawerOpen: false,
  message: null,
};
let counter = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<CartState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function say(kind: CartMessage["kind"], text: string): void {
  counter += 1;
  set({ message: { kind, text, id: counter } });
}

/** După autentificare sau deconectare: coșul vizibil nu mai e cel de dinainte; se reîncarcă la următoarea afișare. */
export function resetCart(): void {
  set({ cart: null, count: null, loadFailed: false });
}

export function useCartState(): CartState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export async function loadCartCount(): Promise<void> {
  if (state.count !== null) return;
  try {
    set({ count: await getCartCountAction() });
  } catch {
    // insigna rămâne fără număr; coșul se încarcă la deschidere
  }
}

export async function loadCart(): Promise<void> {
  set({ loading: true, loadFailed: false });
  try {
    const cart = await getCartAction();
    set({ cart, count: cart.count, loading: false });
  } catch {
    set({ loading: false, loadFailed: true });
  }
}

export function openDrawer(): void {
  set({ drawerOpen: true });
  void loadCart();
}

export function closeDrawer(): void {
  set({ drawerOpen: false });
}

/** Rulează o acțiune de coș: actualizează starea cu coșul primit și anunță rezultatul (succes sau motivul refuzului). */
export async function runCartAction(
  run: () => Promise<CartActionResult>,
  successText: string,
): Promise<CartActionResult> {
  set({ busy: true });
  try {
    const result = await run();
    if (result.cart) set({ cart: result.cart, count: result.cart.count });
    if (result.ok) {
      say("status", successText);
    } else {
      const errors = m().errors as Record<string, string>;
      say("error", errors[result.code] ?? m().errors.failed);
    }
    return result;
  } catch {
    say("error", m().errors.failed);
    return { ok: false, code: "failed", cart: null };
  } finally {
    set({ busy: false });
  }
}

export function addToCart(
  variantId: string,
  quantityTicks: string | undefined,
  title: string,
): Promise<CartActionResult> {
  return runCartAction(
    () => addToCartAction({ variantId, ...(quantityTicks !== undefined && { quantityTicks }) }),
    m().added(title),
  );
}

export function setQuantity(variantId: string, quantityTicks: string): Promise<CartActionResult> {
  return runCartAction(() => setCartQuantityAction({ variantId, quantityTicks }), m().updated);
}

export function removeLine(variantId: string, title: string): Promise<CartActionResult> {
  return runCartAction(() => removeCartLineAction({ variantId }), m().removed(title));
}

export function acknowledgePrice(variantId: string): Promise<CartActionResult> {
  return runCartAction(() => acknowledgeCartPriceAction({ variantId }), m().updated);
}
