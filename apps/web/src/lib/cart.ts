import { cookies, headers } from "next/headers";
import { loadEnv } from "@ecom/config";
import {
  CartService,
  isWellFormedCartToken,
  resolveClientIp,
  type CartOwner,
  type CartRuntimeSettings,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { CART_COOKIE } from "./consent";
import { getStorage } from "./media";
import { getAuth, getCounterStore, getSettings } from "./services";

/**
 * Coșul pe partea de aplicație (Faza 8): serviciul, proprietarul cererii (utilizator logat sau oaspete cu token în cookie) și
 * cookie-ul coșului de oaspete. Cookie-ul e STRICT NECESAR (fără el coșul nu funcționează): nu cere consimțământ; valoarea e
 * aleatorie (256 de biți), `httpOnly`, `SameSite=Lax`, `Secure` în producție, cu valabilitate din setări. În baza de date stă doar
 * amprenta lui (`docs/INTREBARI-AVOCAT.md` §3.4).
 */

export { CART_COOKIE };

const globalForCart = globalThis as unknown as { __ecomCart?: CartService };

export async function readCartSettings(): Promise<CartRuntimeSettings> {
  const settings = getSettings();
  const [catalog, tax, inventory, cart, checkout] = await Promise.all([
    settings.getGroup("catalog"),
    settings.getGroup("tax"),
    settings.getGroup("inventory"),
    settings.getGroup("cart"),
    settings.getGroup("checkout"),
  ]);
  return {
    showSalePricing: catalog.showSalePricing,
    taxStandardRate: tax.standardRate,
    lowStockSteps: inventory.lowStockSteps,
    defaultLeadTimeDays: inventory.defaultLeadTimeDays,
    guestCartDays: cart.guestCartDays,
    userCartDays: cart.userCartDays,
    maxLines: cart.maxLines,
    maxStepsPerLine: cart.maxStepsPerLine,
    freeShippingThreshold: checkout.freeShippingThreshold,
  };
}

/** Serviciul de coș (un singur exemplar per proces). */
export function getCartService(): CartService {
  globalForCart.__ecomCart ??= new CartService({
    db: getDb(),
    storage: getStorage(),
    readSettings: readCartSettings,
  });
  return globalForCart.__ecomCart;
}

async function sessionUserId(): Promise<string | null> {
  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: await headers() });
    return session?.user.id ?? null;
  } catch {
    return null; // fără sesiune valabilă: coș de oaspete
  }
}

export interface ResolvedOwner {
  owner: CartOwner;
  /** Tokenul din cookie, dacă există și are forma corectă. */
  guestToken: string | null;
}

/** Proprietarul coșului pentru cererea curentă: utilizatorul logat, altfel oaspetele din cookie. Doar citire (nu atinge cookie-ul). */
export async function resolveCartOwner(): Promise<ResolvedOwner> {
  const raw = (await cookies()).get(CART_COOKIE)?.value ?? null;
  const guestToken = isWellFormedCartToken(raw) ? raw : null;
  const userId = await sessionUserId();
  return {
    owner: userId ? { kind: "user", userId } : { kind: "guest", token: guestToken },
    guestToken,
  };
}

/** Pune cookie-ul coșului de oaspete (doar din server actions sau rute). */
export async function setCartCookie(token: string): Promise<void> {
  const days = (await getSettings().getGroup("cart")).guestCartDays;
  (await cookies()).set(CART_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(loadEnv().APP_URL).protocol === "https:",
    path: "/",
    maxAge: days * 86_400,
  });
}

export async function clearCartCookie(): Promise<void> {
  (await cookies()).delete(CART_COOKIE);
}

/**
 * Pentru acțiuni care scriu: dacă utilizatorul e logat și mai are un coș de oaspete în cookie, îl îmbină în coșul lui și șterge
 * cookie-ul (rețea de siguranță pe lângă îmbinarea de la autentificare). Întoarce proprietarul de folosit.
 */
export async function resolveOwnerForWrite(): Promise<ResolvedOwner> {
  const resolved = await resolveCartOwner();
  if (resolved.owner.kind === "user" && resolved.guestToken) {
    await getCartService().mergeGuestIntoUser(resolved.guestToken, resolved.owner.userId);
    await clearCartCookie();
    return { owner: resolved.owner, guestToken: null };
  }
  return resolved;
}

/** Limita de modificări pe minut pe adresa IP (setarea `cart.mutationsPerMinute`); `false` = depășită. */
export async function allowCartMutation(): Promise<boolean> {
  const settings = getSettings();
  const [{ trustedProxyHops }, { mutationsPerMinute }] = await Promise.all([
    settings.getGroup("auth"),
    settings.getGroup("cart"),
  ]);
  const ip = resolveClientIp(await headers(), trustedProxyHops);
  // fără IP de încredere (fără proxy) toți împart o cheie comună, cu plafon mai larg
  const counter = await getCounterStore().increment(`cart:${ip ?? "unknown"}`, 60);
  return counter.count <= (ip ? mutationsPerMinute : mutationsPerMinute * 10);
}
