import type { FeatureKey, PermissionKey } from "@ecom/core";

/**
 * Registrul navigației de admin. Fiecare secțiune declară permisiunea (și, dacă e opțională,
 * flag-ul) de care depinde: meniul ascunde ce e oprit sau interzis, iar pagina își verifică singură
 * aceleași condiții (meniul nu e o măsură de securitate, doar de ordine).
 */
export type AdminNavIcon =
  | "dashboard"
  | "orders"
  | "products"
  | "categories"
  | "brands"
  | "attributes"
  | "measureUnits"
  | "partsDiagrams"
  | "inventory"
  | "customers"
  | "discounts"
  | "reviews"
  | "blog"
  | "loyalty"
  | "vouchers"
  | "content"
  | "media"
  | "reports"
  | "settings"
  | "users"
  | "audit";

export interface AdminNavEntry {
  /** Cheia din traduceri (`admin.nav.<id>`). */
  id: AdminNavIcon;
  href: string;
  /** Lipsă = vizibil oricui are `admin.access`. */
  permission?: PermissionKey;
  /** Lipsă = funcționalitate de bază. Prezent = apare doar cu flag-ul pornit. */
  feature?: FeatureKey;
}

export const ADMIN_NAV: readonly AdminNavEntry[] = [
  { id: "dashboard", href: "/admin" },
  { id: "orders", href: "/admin/comenzi", permission: "orders.read" },
  { id: "products", href: "/admin/produse", permission: "products.read" },
  { id: "categories", href: "/admin/categorii", permission: "products.read" },
  { id: "brands", href: "/admin/branduri", permission: "products.read" },
  { id: "attributes", href: "/admin/atribute", permission: "products.read" },
  { id: "measureUnits", href: "/admin/unitati-de-masura", permission: "products.read" },
  {
    id: "partsDiagrams",
    href: "/admin/fise-explodate",
    permission: "products.read",
    feature: "partsDiagrams",
  },
  { id: "inventory", href: "/admin/stoc", permission: "inventory.read" },
  { id: "customers", href: "/admin/clienti", permission: "customers.read" },
  { id: "discounts", href: "/admin/reduceri", permission: "discounts.read" },
  { id: "reviews", href: "/admin/recenzii", permission: "content.read", feature: "reviews" },
  { id: "blog", href: "/admin/blog", permission: "content.read", feature: "blog" },
  { id: "loyalty", href: "/admin/loialitate", permission: "discounts.read", feature: "loyalty" },
  { id: "vouchers", href: "/admin/vouchere", permission: "discounts.read", feature: "vouchers" },
  { id: "content", href: "/admin/continut", permission: "content.read" },
  { id: "media", href: "/admin/media", permission: "media.read" },
  { id: "reports", href: "/admin/rapoarte", permission: "reports.read" },
  { id: "settings", href: "/admin/setari", permission: "settings.read" },
  { id: "users", href: "/admin/utilizatori", permission: "users.manage" },
  { id: "audit", href: "/admin/jurnal", permission: "audit.read" },
];

export interface NavVisibility {
  can: (permission: PermissionKey) => boolean;
  isEnabled: (feature: FeatureKey) => boolean;
}

/** Intrările pe care utilizatorul le poate vedea: permisiunea există ȘI flag-ul (dacă are) e pornit. */
export function visibleNav(
  entries: readonly AdminNavEntry[],
  visibility: NavVisibility,
): AdminNavEntry[] {
  return entries.filter(
    (entry) =>
      (!entry.permission || visibility.can(entry.permission)) &&
      (!entry.feature || visibility.isEnabled(entry.feature)),
  );
}

/** Intrarea de meniu pentru o cale (`/admin/comenzi/123` → comenzi), sau `undefined`. */
export function navEntryForPath(
  pathname: string,
  entries: readonly AdminNavEntry[] = ADMIN_NAV,
): AdminNavEntry | undefined {
  return entries
    .filter((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export interface Crumb {
  label: string;
  /** `null` pentru ultima migă (pagina curentă, fără link). */
  href: string | null;
}

/**
 * Firimiturile pentru o cale de admin: Panou › secțiune › segmente. Etichetele secțiunilor vin din
 * traduceri (`labelFor`), segmentele necunoscute (ex. un id) se afișează decodate.
 */
export function breadcrumbsFor(
  pathname: string,
  labelFor: (id: AdminNavIcon) => string,
  homeLabel: string,
  entries: readonly AdminNavEntry[] = ADMIN_NAV,
  /** Eticheta unui segment după secțiune (ex. „nou”, un id); `null` = afișat decodat. */
  segmentLabel?: (
    sectionId: AdminNavIcon | null,
    raw: string,
    previous: string | null,
  ) => string | null,
): Crumb[] {
  const path = pathname.split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "admin") return [];
  const crumbs: Crumb[] = [{ label: homeLabel, href: "/admin" }];
  const section = navEntryForPath(path, entries);
  let consumed = 1;
  if (section && section.href !== "/admin") {
    crumbs.push({ label: labelFor(section.id), href: section.href });
    consumed = section.href.split("/").filter(Boolean).length;
  }
  let href = `/${segments.slice(0, consumed).join("/")}`;
  const rest = segments.slice(consumed);
  for (const [index, raw] of rest.entries()) {
    href += `/${raw}`;
    let label = raw;
    try {
      label = decodeURIComponent(raw);
    } catch {
      // segment cu % invalid: îl afișăm cum e
    }
    crumbs.push({
      label: segmentLabel?.(section?.id ?? null, raw, rest[index - 1] ?? null) ?? label,
      href,
    });
  }
  const last = crumbs[crumbs.length - 1];
  if (last) last.href = null;
  return crumbs;
}
