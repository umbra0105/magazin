import type { FeatureKey, PermissionKey } from "@ecom/core";

/**
 * Registrul navigației de admin. Fiecare secțiune declară permisiunea (și, dacă e opțională,
 * flag-ul) de care depinde: meniul ascunde ce e oprit sau interzis, iar pagina își verifică singură
 * aceleași condiții (meniul nu e o măsură de securitate, doar de ordine).
 *
 * Convenție: o intrare de meniu pe GRUP (Catalog, apoi Comenzi, Clienți, Marketing, Conținut, Setări), care se
 * deschide și se închide în meniul din stânga și are ecranele grupului ca sub-elemente (`children`), nu ca intrări
 * separate de meniu și nu ca bară de taburi. Logica e generică: orice intrare cu `children` e grup.
 */

/** Intrările de pe primul nivel al meniului (au pictogramă). */
export type AdminNavSectionId =
  | "dashboard"
  | "orders"
  | "catalog"
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

/** Sub-elementele grupului «Catalog» (fără pictogramă; etichetele vin din traduceri). */
export type AdminNavItemId =
  | "allProducts"
  | "categories"
  | "brands"
  | "attributes"
  | "measureUnits"
  | "partsDiagrams"
  | "inventory";

/** Orice id cu etichetă în `admin.nav.<id>`. */
export type AdminNavIcon = AdminNavSectionId | AdminNavItemId;

/**
 * Un ecran dintr-un grup de meniu, afișat ca sub-element sub grup. Fiecare element are permisiunea (și, dacă e
 * opțional, flag-ul) ecranului: meniul îl ascunde, iar pagina își verifică singură aceleași condiții.
 */
export interface AdminNavItem {
  /** Cheia din traduceri (`admin.nav.<id>`). */
  id: AdminNavIcon;
  href: string;
  permission: PermissionKey;
  feature?: FeatureKey;
  /**
   * Parametrii din adresă pe care ecranul îi înțelege la fel ca alte elemente (ex. căutarea după produs). Se păstrează la
   * trecerea între două elemente care îi declară amândouă; orice altceva (filtre, pagina) se resetează.
   */
  keepParams?: readonly string[];
}

export interface AdminNavEntry {
  /** Cheia din traduceri (`admin.nav.<id>`). */
  id: AdminNavSectionId;
  href: string;
  /** Lipsă = vizibil oricui are `admin.access`. */
  permission?: PermissionKey;
  /** Lipsă = funcționalitate de bază. Prezent = apare doar cu flag-ul pornit. */
  feature?: FeatureKey;
  /**
   * Grup care se deschide și se închide: o singură intrare de meniu pentru toate ecranele grupului. Apare dacă
   * utilizatorul poate vedea cel puțin un element; `permission`/`feature` ale intrării nu se folosesc (drepturile sunt
   * ale elementelor). `href` e prefixul tuturor adreselor grupului (grupul se deschide singur pe ele).
   */
  children?: readonly AdminNavItem[];
}

/** Ecranele grupului «Catalog», în ordinea din meniu. «Produse» ține evidențiate și editorul, produsul nou și importul. */
export const CATALOG_ITEMS: readonly AdminNavItem[] = [
  { id: "allProducts", href: "/admin/produse", permission: "products.read", keepParams: ["q"] },
  { id: "categories", href: "/admin/produse/categorii", permission: "products.read" },
  { id: "brands", href: "/admin/produse/branduri", permission: "products.read" },
  { id: "attributes", href: "/admin/produse/atribute", permission: "products.read" },
  { id: "measureUnits", href: "/admin/produse/unitati-de-masura", permission: "products.read" },
  {
    id: "partsDiagrams",
    href: "/admin/produse/fise-explodate",
    permission: "products.read",
    feature: "partsDiagrams",
  },
  { id: "inventory", href: "/admin/produse/stoc", permission: "inventory.read", keepParams: ["q"] },
];

/** Destinația unui element, cu parametrii păstrați din ecranul curent (vezi `keepParams`). */
export function itemHref(
  item: Pick<AdminNavItem, "href" | "keepParams">,
  current: Pick<AdminNavItem, "keepParams"> | undefined,
  params: { get(name: string): string | null },
): string {
  const kept = new URLSearchParams();
  for (const name of item.keepParams ?? []) {
    if (!current?.keepParams?.includes(name)) continue;
    const value = params.get(name);
    if (value) kept.set(name, value);
  }
  const query = kept.toString();
  return query ? `${item.href}?${query}` : item.href;
}

export const ADMIN_NAV: readonly AdminNavEntry[] = [
  { id: "dashboard", href: "/admin" },
  { id: "orders", href: "/admin/comenzi", permission: "orders.read" },
  { id: "catalog", href: "/admin/produse", children: CATALOG_ITEMS },
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

/**
 * Intrarea vizibilă: la grupuri, `href` e primul element permis (destinația „implicită” a grupului) și `children` doar
 * elementele permise; `basePath` e prefixul pentru starea activă și pentru deschiderea automată.
 */
export interface VisibleNavEntry extends AdminNavEntry {
  basePath: string;
}

/** Elementele pe care utilizatorul le poate vedea: permisiunea există ȘI flag-ul (dacă are) e pornit. */
export function visibleItems(
  items: readonly AdminNavItem[],
  visibility: NavVisibility,
): AdminNavItem[] {
  return items.filter(
    (item) =>
      visibility.can(item.permission) && (!item.feature || visibility.isEnabled(item.feature)),
  );
}

/**
 * Intrările pe care utilizatorul le poate vedea: permisiunea există ȘI flag-ul (dacă are) e pornit. Un grup apare doar
 * dacă are cel puțin un element vizibil, și atunci le păstrează doar pe acelea.
 */
export function visibleNav(
  entries: readonly AdminNavEntry[],
  visibility: NavVisibility,
): VisibleNavEntry[] {
  const result: VisibleNavEntry[] = [];
  for (const entry of entries) {
    if (entry.children) {
      const children = visibleItems(entry.children, visibility);
      const first = children[0];
      if (first) result.push({ ...entry, href: first.href, basePath: entry.href, children });
      continue;
    }
    if (
      (!entry.permission || visibility.can(entry.permission)) &&
      (!entry.feature || visibility.isEnabled(entry.feature))
    ) {
      result.push({ ...entry, basePath: entry.href });
    }
  }
  return result;
}

const matchesPath = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

/** Calea e pe adresa grupului sau sub ea (`/admin/produse/stoc` în `/admin/produse`); nu confundă prefixe de nume. */
export function pathInGroup(pathname: string, groupHref: string): boolean {
  return matchesPath(pathname, groupHref);
}

/**
 * Elementul evidențiat pentru o cale: cel cu prefixul cel mai lung, deci editorul de produs, produsul nou și importul
 * (care nu au element propriu) țin evidențiat «Produse», al cărui prefix e adresa grupului. `undefined` în afara grupului.
 */
export function activeItemId(
  pathname: string,
  items: readonly Pick<AdminNavItem, "id" | "href">[],
): AdminNavIcon | undefined {
  return items
    .filter((item) => matchesPath(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.id;
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
 * Firimiturile pentru o cale de admin: Panou › secțiune › [element] › segmente. Etichetele secțiunilor vin din
 * traduceri (`labelFor`), segmentele necunoscute (ex. un id) se afișează decodate. La grupuri, `segmentLabel` primește
 * id-ul elementului (ex. `inventory`, `allProducts`) ca secțiune când calea e sub un element.
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
  let sectionId: AdminNavIcon | null = section?.id ?? null;
  let consumed = 1;
  if (section && section.href !== "/admin") {
    crumbs.push({ label: labelFor(section.id), href: section.href });
    consumed = section.href.split("/").filter(Boolean).length;
    // elementul grupului (Catalog › Stoc); pe adresa grupului sau sub una fără element propriu e «Produse»
    const item = section.children
      ?.filter((candidate) => matchesPath(path, candidate.href))
      .sort((a, b) => b.href.length - a.href.length)[0];
    if (item) {
      crumbs.push({ label: labelFor(item.id), href: item.href });
      consumed = item.href.split("/").filter(Boolean).length;
      sectionId = item.id;
    }
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
      label: segmentLabel?.(sectionId, raw, rest[index - 1] ?? null) ?? label,
      href,
    });
  }
  const last = crumbs[crumbs.length - 1];
  if (last) last.href = null;
  return crumbs;
}
