import { cookies, headers } from "next/headers";
import { loadEnv } from "@ecom/config";
import {
  CartService,
  CheckoutService,
  DemoShippingRateProvider,
  GeoService,
  reservationExpiresAt,
  ShippingService,
  createPrismaShippingStore,
  deriveKey,
  resolveClientIp,
  signOrderAccess,
  verifyOrderAccess,
  type CheckoutSettings,
  type CuiLookupPort,
  type ShippingRuntimeSettings,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { AnafClient } from "@ecom/integrations";
import { ORDER_ACCESS_COOKIE } from "./consent";
import { getStorage } from "./media";
import { getPaymentConfig } from "./payments";
import { readCartSettings } from "./cart";
import { getCounterStore, getSettings } from "./services";
import { getStorefrontFormat } from "./storefront-catalog";

/**
 * Checkout-ul pe partea de aplicație (Faza 9): serviciile (un exemplar per proces), setările citite din baza de date la fiecare
 * cerere (nimic hardcodat), furnizorul de tarife (DEMO în Faza 9), clientul ANAF (cu timp limită din setări), cookie-ul de acces la
 * confirmare (semnat, `httpOnly`) și limitele de cereri pe IP. Logica de business rămâne în `@ecom/core`.
 */

const globalForCheckout = globalThis as unknown as {
  __ecomCheckout?: CheckoutService;
  __ecomShipping?: ShippingService;
};

export async function readCheckoutSettings(): Promise<CheckoutSettings> {
  const settings = getSettings();
  const [tax, regional, inventory, checkout, payment, company] = await Promise.all([
    settings.getGroup("tax"),
    settings.getGroup("regional"),
    settings.getGroup("inventory"),
    settings.getGroup("checkout"),
    settings.getGroup("payment"),
    settings.getGroup("company"),
  ]);
  return {
    taxStandardRate: tax.standardRate,
    allowedCountries: regional.allowedCountries,
    timeZone: regional.timezone,
    nonWorkingDates: regional.nonWorkingDates,
    reservationMinutes: inventory.reservationMinutes,
    transferReservationWorkdays: inventory.transferReservationWorkdays,
    orderNumberPrefix: checkout.orderNumberPrefix,
    orderNumberDigits: checkout.orderNumberDigits,
    codMaxIndividualMinor: payment.codMaxAmountIndividual,
    codMaxCompanyMinor: payment.codMaxAmountCompany,
    bankDetailsConfigured: company.iban.trim() !== "",
    guestCheckoutEnabled: checkout.guestCheckoutEnabled,
    // cardul se oferă doar dacă există un furnizor activ, configurat (și, la LIVE, verificat în sandbox)
    cardProvider: await getPaymentConfig().activeCardProvider(),
    cardRetryHours: payment.cardRetryHours,
  };
}

export async function readShippingSettings(): Promise<ShippingRuntimeSettings> {
  const settings = getSettings();
  const [checkout, shipping, company] = await Promise.all([
    settings.getGroup("checkout"),
    settings.getGroup("shipping"),
    settings.getGroup("company"),
  ]);
  return {
    freeShippingThresholdMinor: checkout.freeShippingThreshold,
    freeShippingClasses: checkout.freeShippingClasses,
    pickupEnabled: shipping.pickupEnabled,
    // ridicarea e de la adresa magazinului (`company.address`); fără ea nu se oferă
    pickupAddress: company.address,
    easyboxEnabled: shipping.easyboxEnabled,
    quoteTimeoutMs: shipping.quoteTimeoutMs,
  };
}

export function getShippingService(): ShippingService {
  globalForCheckout.__ecomShipping ??= new ShippingService({
    // Faza 9: furnizorul DEMO (tarife demonstrative); agregatorul real vine în Faza 12, prin aceeași interfață
    provider: new DemoShippingRateProvider(),
    store: createPrismaShippingStore(getDb()),
    readSettings: readShippingSettings,
  });
  return globalForCheckout.__ecomShipping;
}

/** ANAF cu timp limită din setări; nu aruncă niciodată (vezi `AnafClient`). */
export const anafPort: CuiLookupPort = {
  async lookup(cui, today) {
    const timeoutMs = (await getSettings().getGroup("checkout")).anafTimeoutMs;
    return new AnafClient({ timeoutMs }).lookup(cui, today);
  },
};

export function getCheckoutService(): CheckoutService {
  globalForCheckout.__ecomCheckout ??= new CheckoutService({
    db: getDb(),
    createCart: (db) =>
      new CartService({ db, storage: getStorage(), readSettings: readCartSettings }),
    shipping: getShippingService(),
    cui: anafPort,
    readSettings: readCheckoutSettings,
  });
  return globalForCheckout.__ecomCheckout;
}

export function getGeoService(): GeoService {
  return new GeoService(getDb());
}

// ---------------------------------------------------------------------------------------------------------------- acces

const ACCESS_SECONDS = 2 * 60 * 60;
const accessKey = () => deriveKey(loadEnv().APP_KEY, "ecom:checkout:order-access:v1");

/** Cookie-ul de acces la confirmare: doar din server actions sau rute. */
export async function setOrderAccessCookie(orderId: string): Promise<void> {
  const expires = Math.floor(Date.now() / 1000) + ACCESS_SECONDS;
  (await cookies()).set(ORDER_ACCESS_COOKIE, signOrderAccess(orderId, accessKey(), expires), {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(loadEnv().APP_URL).protocol === "https:",
    path: "/",
    maxAge: ACCESS_SECONDS,
  });
}

/** ID-ul comenzii pe care cererea curentă are voie să o vadă (din cookie semnat), sau `null`. */
export async function readOrderAccess(): Promise<string | null> {
  const token = (await cookies()).get(ORDER_ACCESS_COOKIE)?.value;
  if (!token) return null;
  return verifyOrderAccess(token, accessKey(), Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------------------------------------------------------- limite

export type CheckoutLimitScope = "cui" | "place" | "track" | "geo" | "pay" | "payRetry";

const LIMITS: Record<CheckoutLimitScope, { perMinute: number }> = {
  /** ANAF acceptă o cerere pe secundă; 12 pe minut pe IP e mult peste uzul normal. */
  cui: { perMinute: 12 },
  place: { perMinute: 20 },
  track: { perMinute: 10 },
  geo: { perMinute: 120 },
  /** Verificarea stării plății (pagina de așteptare interoghează la câteva secunde). */
  pay: { perMinute: 60 },
  /** «Reîncearcă plata» și linkul de plată: fiecare cerere poate porni o tentativă și o rezervare. */
  payRetry: { perMinute: 6 },
};

/** Limita de cereri pe minut pe adresa IP, pe tipul de operație; `false` = depășită. */
export async function allowCheckoutRequest(scope: CheckoutLimitScope): Promise<boolean> {
  const auth = await getSettings().getGroup("auth");
  const ip = resolveClientIp(await headers(), auth.trustedProxyHops);
  const counter = await getCounterStore().increment(`checkout:${scope}:${ip ?? "unknown"}`, 60);
  const limit = LIMITS[scope].perMinute;
  return counter.count <= (ip ? limit : limit * 10);
}

/** Termenul rezervării pentru transfer (afișat înainte de plasare), în ora magazinului. */
export async function transferDeadlineText(): Promise<string> {
  const settings = await readCheckoutSettings();
  const end = reservationExpiresAt("transfer", new Date(), {
    reservationMinutes: settings.reservationMinutes,
    transferReservationWorkdays: settings.transferReservationWorkdays,
    timeZone: settings.timeZone,
    nonWorkingDates: settings.nonWorkingDates,
  });
  const format = await getStorefrontFormat();
  return new Intl.DateTimeFormat(format.locale, {
    dateStyle: "long",
    timeZone: settings.timeZone,
  }).format(end);
}

/** Datele bancare ale magazinului (din setări), pentru afișarea la plata prin transfer; `null` dacă IBAN-ul nu e completat. */
export async function readBankDetails(): Promise<{
  holder: string;
  bankName: string;
  iban: string;
} | null> {
  const company = await getSettings().getGroup("company");
  if (company.iban.trim() === "") return null;
  return { holder: company.legalName, bankName: company.bankName, iban: company.iban };
}
