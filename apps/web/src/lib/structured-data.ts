import type { PublicAvailability, VisibleStockState } from "@ecom/core";

/**
 * Date structurate JSON-LD (docs/19 §1), construite pe SERVER din aceleași date ca pagina: prețul și disponibilitatea din JSON-LD
 * sunt exact cele afișate (nu se recalculează altundeva). Funcții pure. `jsonLdText` scoate `<` din text (`<`), ca nicio valoare
 * din baza de date să nu poată închide eticheta `<script>`.
 */

export type JsonLd = Record<string, unknown>;

export function jsonLdText(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/** Bani (întreg, unități minore) → «199.00», fără rotunjiri și fără `float`. */
export function priceDecimal(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const AVAILABILITY: Record<VisibleStockState, string> = {
  in_stock: "https://schema.org/InStock",
  limited: "https://schema.org/LimitedAvailability",
  on_order: "https://schema.org/BackOrder",
  unavailable: "https://schema.org/OutOfStock",
};

export const schemaAvailability = (a: Pick<PublicAvailability, "state">): string =>
  AVAILABILITY[a.state];

const abs = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;

export function breadcrumbList(base: string, items: { name: string; href: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: abs(base, item.href),
    })),
  };
}

export function itemList(
  base: string,
  items: { name: string; href: string }[],
  offset = 0,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: offset + index + 1,
      name: item.name,
      url: abs(base, item.href),
    })),
  };
}

export interface ProductLdInput {
  base: string;
  href: string;
  name: string;
  description: string | undefined;
  images: string[];
  brand: string | null;
  currency: string;
  variants: {
    sku: string;
    ean: string | null;
    amount: number;
    availability: PublicAvailability;
  }[];
}

/** `Product` cu o `Offer` pe variantă (prețul afișat și disponibilitatea vizibilă); fără costuri și fără cantități de stoc. */
export function productLd(input: ProductLdInput): JsonLd {
  const offers = input.variants.map((variant) => ({
    "@type": "Offer",
    sku: variant.sku,
    url: abs(input.base, input.href),
    price: priceDecimal(variant.amount),
    priceCurrency: input.currency,
    availability: schemaAvailability(variant.availability),
    itemCondition: "https://schema.org/NewCondition",
  }));
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.images.length > 0 ? { image: input.images } : {}),
    ...(input.variants[0] ? { sku: input.variants[0].sku } : {}),
    ...(input.variants[0]?.ean ? { gtin: input.variants[0].ean } : {}),
    ...(input.brand ? { brand: { "@type": "Brand", name: input.brand } } : {}),
    ...(offers.length === 1 ? { offers: offers[0] } : offers.length > 1 ? { offers } : {}),
  };
}

export function organizationLd(input: {
  base: string;
  name: string;
  legalName: string;
  logo: string | null;
  address: { street: string; city: string; county: string; postalCode: string; country: string };
  phone: string;
  email: string;
}): JsonLd {
  const hasAddress = Boolean(input.address.street || input.address.city);
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: input.name,
    url: abs(input.base, "/"),
    ...(input.legalName ? { legalName: input.legalName } : {}),
    ...(input.logo ? { logo: input.logo } : {}),
    ...(hasAddress
      ? {
          address: {
            "@type": "PostalAddress",
            ...(input.address.street ? { streetAddress: input.address.street } : {}),
            ...(input.address.city ? { addressLocality: input.address.city } : {}),
            ...(input.address.county ? { addressRegion: input.address.county } : {}),
            ...(input.address.postalCode ? { postalCode: input.address.postalCode } : {}),
            ...(input.address.country ? { addressCountry: input.address.country } : {}),
          },
        }
      : {}),
    ...(input.phone || input.email
      ? {
          contactPoint: {
            "@type": "ContactPoint",
            contactType: "customer service",
            ...(input.phone ? { telephone: input.phone } : {}),
            ...(input.email ? { email: input.email } : {}),
          },
        }
      : {}),
  };
}

/** `WebSite` cu `SearchAction` spre adresa REALĂ de căutare (`/cautare?q=`). */
export function websiteLd(base: string, name: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name,
    url: abs(base, "/"),
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: abs(base, "/cautare?q={search_term_string}") },
      "query-input": "required name=search_term_string",
    },
  };
}
