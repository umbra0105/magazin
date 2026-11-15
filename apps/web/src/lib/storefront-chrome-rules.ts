/**
 * Regulile pure ale cadrului vitrinei (header, footer): ce element e activ, dezactivat sau ascuns; lățimea containerului; legătura
 * de telefon; linkurile din footer. Fără acces la date, ca să se poată testa pe valori. Încărcarea datelor: `storefront-chrome.ts`.
 */

/**
 * Elementele din header care aparțin fazelor viitoare. Cât timp faza lor nu e gata, apar doar ca structură (dezactivate), fără
 * funcționalitate fictivă; faza care le face întoarce valoarea la `true` (aici, într-un singur loc) și le activează:
 *  - `search`: căutarea cu rezultate (Faza 7);
 *  - `cart`: coșul (Faza 8);
 *  - `wishlist`: lista de favorite (după Faza 7; în spatele steagului `wishlist`).
 */
export const STOREFRONT_READINESS = { search: false, cart: false, wishlist: false } as const;

export type SlotState = "active" | "disabled" | "hidden";

export interface HeaderSlots {
  search: SlotState;
  cart: SlotState;
  wishlist: SlotState;
}

export function headerSlots(input: {
  wishlistFlag: boolean;
  readiness: { search: boolean; cart: boolean; wishlist: boolean };
}): HeaderSlots {
  const { readiness } = input;
  return {
    search: readiness.search ? "active" : "disabled",
    cart: readiness.cart ? "active" : "disabled",
    wishlist: !input.wishlistFlag ? "hidden" : readiness.wishlist ? "active" : "disabled",
  };
}

export type ContainerWidth = "lg" | "xl" | "2xl";

/** Setarea `appearance.containerWidth` e text liber în registru; aici se reduce la una dintre valorile cunoscute (implicit `xl`). */
export function containerWidthOf(value: string): ContainerWidth {
  return value === "lg" || value === "xl" || value === "2xl" ? value : "xl";
}

/** `tel:` doar dintr-un număr cu cel puțin 6 cifre; păstrează plusul de la început și cifrele, nimic altceva. */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 6 || !/^[+\d\s().-]+$/.test(trimmed)) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** Linkurile legale și informative din footer (adresele din `docs/03` §1; paginile se completează în Faza 16). */
export const FOOTER_LEGAL_LINKS = [
  { key: "terms", href: "/termeni-si-conditii" },
  { key: "privacy", href: "/politica-de-confidentialitate" },
  { key: "cookies", href: "/politica-cookie-uri" },
  { key: "returns", href: "/politica-de-retur" },
] as const;

export const FOOTER_INFO_LINKS = [
  { key: "delivery", href: "/livrare-si-plata" },
  { key: "warranty", href: "/garantii" },
  { key: "faq", href: "/intrebari-frecvente" },
  { key: "about", href: "/despre-noi" },
  { key: "contact", href: "/contact" },
] as const;
