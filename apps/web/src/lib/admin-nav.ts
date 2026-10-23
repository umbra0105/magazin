import type { FeatureKey, PermissionKey } from "@ecom/core";

/**
 * Registrul navigației de admin. Fiecare secțiune declară permisiunea (și, dacă e opțională,
 * flag-ul) de care depinde: meniul ascunde ce e oprit sau interzis, iar pagina își verifică singură
 * aceleași condiții (meniul nu e o măsură de securitate, doar de ordine).
 *
 * Convenție: o intrare de meniu pe GRUP (Produse, apoi Comenzi, Clienți, Marketing, Conținut, Setări), cu
 * ecranele grupului ca taburi (`tabs`), nu ca intrări separate de meniu.
 */
export type AdminNavIcon =
  | "dashboard"
  | "orders"
  | "products"
  | "allProducts"
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

/**
 * Un ecran dintr-un grup de meniu, afișat ca tab în bara grupului. Fiecare tab are permisiunea (și, dacă e
 * opțional, flag-ul) ecranului: bara îl ascunde, iar pagina își verifică singură aceleași condiții.
 */
export interface AdminNavTab {
  /** Cheia din traduceri (`admin.nav.<id>`). */
  id: AdminNavIcon;
  href: string;
  permission: PermissionKey;
  feature?: FeatureKey;
  /** Activ doar pe adresa exactă (tabul-listă al grupului), nu și pe adresele de sub ea. */
  exact?: boolean;
  /**
   * Parametrii din adresă pe care ecranul îi înțelege la fel ca alte taburi (ex. căutarea după produs). Se păstrează la
   * trecerea între două taburi care îi declară amândouă; orice altceva (filtre, pagina) se resetează.
   */
  keepParams?: readonly string[];
}

export interface AdminNavEntry {
  /** Cheia din traduceri (`admin.nav.<id>`). */
  id: AdminNavIcon;
  href: string;
  /** Lipsă = vizibil oricui are `admin.access`. */
  permission?: PermissionKey;
  /** Lipsă = funcționalitate de bază. Prezent = apare doar cu flag-ul pornit. */
  feature?: FeatureKey;
  /**
   * Grup cu taburi: o singură intrare de meniu pentru toate ecranele grupului. Apare dacă utilizatorul
   * poate vedea cel puțin un tab și duce la primul tab permis; `permission`/`feature` ale intrării nu se
   * folosesc (drepturile sunt ale taburilor).
   */
  tabs?: readonly AdminNavTab[];
}

/** Ecranele grupului «Produse», în ordinea din bara de taburi. */
export const PRODUCT_TABS: readonly AdminNavTab[] = [
  {
    id: "allProducts",
    href: "/admin/produse",
    permission: "products.read",
    exact: true,
    keepParams: ["q"],
  },
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

/** Destinația unui tab, cu parametrii păstrați din ecranul curent (vezi `keepParams`). */
export function tabHref(
  tab: Pick<AdminNavTab, "href" | "keepParams">,
  current: Pick<AdminNavTab, "keepParams"> | undefined,
  params: { get(name: string): string | null },
): string {
  const kept = new URLSearchParams();
  for (const name of tab.keepParams ?? []) {
    if (!current?.keepParams?.includes(name)) continue;
    const value = params.get(name);
    if (value) kept.set(name, value);
  }
  const query = kept.toString();
  return query ? `${tab.href}?${query}` : tab.href;
}

export const ADMIN_NAV: readonly AdminNavEntry[] = [
  { id: "dashboard", href: "/admin" },
  { id: "orders", href: "/admin/comenzi", permission: "orders.read" },
  { id: "products", href: "/admin/produse", tabs: PRODUCT_TABS },
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

/** Intrarea vizibilă: `href` e destinația clicului (primul tab permis la grupuri), `basePath` prefixul pentru starea activă. */
export interface VisibleNavEntry extends AdminNavEntry {
  basePath: string;
}

/** Taburile pe care utilizatorul le poate vedea: permisiunea există ȘI flag-ul (dacă are) e pornit. */
export function visibleTabs(
  tabs: readonly AdminNavTab[],
  visibility: NavVisibility,
): AdminNavTab[] {
  return tabs.filter(
    (tab) => visibility.can(tab.permission) && (!tab.feature || visibility.isEnabled(tab.feature)),
  );
}

/**
 * Intrările pe care utilizatorul le poate vedea: permisiunea există ȘI flag-ul (dacă are) e pornit. Un grup cu
 * taburi apare doar dacă are cel puțin un tab vizibil și duce la primul.
 */
export function visibleNav(
  entries: readonly AdminNavEntry[],
  visibility: NavVisibility,
): VisibleNavEntry[] {
  const result: VisibleNavEntry[] = [];
  for (const entry of entries) {
    if (entry.tabs) {
      const tabs = visibleTabs(entry.tabs, visibility);
      const first = tabs[0];
      if (first) result.push({ ...entry, href: first.href, basePath: entry.href, tabs });
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

/** Tabul activ pentru o cale (cel cu prefixul cel mai lung), sau `undefined` (ex. editorul de produs). */
export function activeTabId(
  pathname: string,
  tabs: readonly Pick<AdminNavTab, "id" | "href" | "exact">[],
): AdminNavIcon | undefined {
  return tabs
    .filter((tab) => (tab.exact ? pathname === tab.href : matchesPath(pathname, tab.href)))
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
 * Firimiturile pentru o cale de admin: Panou › secțiune › [tab] › segmente. Etichetele secțiunilor vin din
 * traduceri (`labelFor`), segmentele necunoscute (ex. un id) se afișează decodate. La grupurile cu taburi,
 * `segmentLabel` primește id-ul tabului (ex. `inventory`) ca secțiune când calea e sub un tab.
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
    // tabul grupului (Produse › Stoc); tabul-listă (adresa grupului) nu dublează intrarea
    const tab = section.tabs
      ?.filter((candidate) => candidate.href !== section.href && matchesPath(path, candidate.href))
      .sort((a, b) => b.href.length - a.href.length)[0];
    if (tab) {
      crumbs.push({ label: labelFor(tab.id), href: tab.href });
      consumed = tab.href.split("/").filter(Boolean).length;
      sectionId = tab.id;
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
