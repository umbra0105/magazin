import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AddressBook, type AccountUser, type FeatureKey } from "@ecom/core";
import { getDb } from "@ecom/db";
import { anafPort } from "./checkout";
import { getFeatureFlags, getCounterStore } from "./services";
import { getCurrentResolution } from "./session";

/**
 * Contul clientului pe partea de aplicație (Faza 14): clientul autentificat (cu proprietatea comenzilor stabilită din emailul
 * VERIFICAT), limitele de cereri pe client și agenda de adrese. Logica de business rămâne în `@ecom/core`. Pagina verifică sesiunea
 * pe server (middleware-ul vede doar existența cookie-ului); un cont anonimizat nu mai are acces.
 */
export interface CustomerContext {
  user: AccountUser;
  /** Numele din cont (pentru salut). */
  name: string;
  /** Un cont cu acces în administrare are și permisiuni; nu schimbă regulile contului de client. */
  isStaff: boolean;
}

export async function getCustomer(): Promise<CustomerContext | null> {
  const resolution = await getCurrentResolution();
  if (resolution.status !== "ok") return null;
  const row = await getDb().user.findUnique({
    where: { id: resolution.subject.userId },
    select: { id: true, name: true, email: true, emailVerified: true, anonymizedAt: true },
  });
  if (!row || row.anonymizedAt) return null;
  return {
    user: { id: row.id, email: row.email, emailVerified: row.emailVerified, anonymizedAt: null },
    name: row.name,
    isStaff: resolution.subject.permissions.has("admin.access"),
  };
}

/** Clientul autentificat sau redirecționare la autentificare, cu întoarcere la pagina cerută. */
export async function requireCustomer(nextPath: string): Promise<CustomerContext> {
  const customer = await getCustomer();
  if (!customer) redirect(`/autentificare?next=${encodeURIComponent(nextPath)}`);
  return customer;
}

/** Ruta unei funcționalități opționale: 404 dacă flag-ul e oprit (meniul, ruta ȘI codul). */
export async function requireFlag(key: FeatureKey): Promise<void> {
  if (!(await getFeatureFlags().isEnabled(key))) notFound();
}

export async function isFlagOn(key: FeatureKey): Promise<boolean> {
  return getFeatureFlags().isEnabled(key);
}

export type AccountLimitScope = "export" | "delete" | "return" | "address" | "wishlist" | "digital";

const LIMITS: Record<AccountLimitScope, { perWindow: number; windowSeconds: number }> = {
  export: { perWindow: 5, windowSeconds: 3600 },
  delete: { perWindow: 5, windowSeconds: 3600 },
  return: { perWindow: 20, windowSeconds: 3600 },
  address: { perWindow: 60, windowSeconds: 3600 },
  wishlist: { perWindow: 240, windowSeconds: 3600 },
  /** Linkuri de acces la produse digitale (fiecare descărcare consumă din limita produsului). */
  digital: { perWindow: 240, windowSeconds: 3600 },
};

/** Limita de cereri pe CLIENT și pe tip de operație (export, ștergere, inițiere retur …); `false` = depășită. */
export async function allowAccountRequest(
  scope: AccountLimitScope,
  userId: string,
): Promise<boolean> {
  const limit = LIMITS[scope];
  const counter = await getCounterStore().increment(
    `account:${scope}:${userId}`,
    limit.windowSeconds,
  );
  return counter.count <= limit.perWindow;
}

export function getAddressBook(): AddressBook {
  return new AddressBook({
    db: getDb(),
    cui: anafPort,
    today: () => new Date().toISOString().slice(0, 10),
  });
}

/** Adresa paginii curente, pentru redirecționarea de după autentificare (doar căi interne). */
export async function currentPath(fallback: string): Promise<string> {
  const path = (await headers()).get("x-pathname");
  return path && path.startsWith("/") && !path.startsWith("//") ? path : fallback;
}
