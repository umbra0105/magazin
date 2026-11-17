import { describe, expect, it } from "vitest";
import {
  breadcrumbList,
  itemList,
  jsonLdText,
  organizationLd,
  priceDecimal,
  productLd,
  schemaAvailability,
  websiteLd,
} from "./structured-data";

const BASE = "https://magazin.test";
const av = (state: "in_stock" | "limited" | "on_order" | "unavailable") => ({
  state,
  purchasable: state !== "unavailable",
  leadTimeDays: null,
  remainingSteps: null,
});

describe("priceDecimal", () => {
  it("bani întregi → zecimal exact, fără float", () => {
    expect(priceDecimal(19900)).toBe("199.00");
    expect(priceDecimal(5)).toBe("0.05");
    expect(priceDecimal(1999)).toBe("19.99");
    expect(priceDecimal(0)).toBe("0.00");
    expect(priceDecimal(123456789)).toBe("1234567.89");
  });
});

describe("jsonLdText", () => {
  it("nicio valoare nu poate închide eticheta script", () => {
    const text = jsonLdText({ name: "</script><script>alert(1)</script>" });
    expect(text).not.toContain("</script>");
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual({ name: "</script><script>alert(1)</script>" });
  });
});

describe("schemaAvailability", () => {
  it("stările vizibile → vocabularul schema.org", () => {
    expect(schemaAvailability(av("in_stock"))).toBe("https://schema.org/InStock");
    expect(schemaAvailability(av("limited"))).toBe("https://schema.org/LimitedAvailability");
    expect(schemaAvailability(av("on_order"))).toBe("https://schema.org/BackOrder");
    expect(schemaAvailability(av("unavailable"))).toBe("https://schema.org/OutOfStock");
  });
});

describe("liste", () => {
  it("BreadcrumbList cu poziții de la 1 și adrese absolute", () => {
    const ld = breadcrumbList(`${BASE}/`, [
      { name: "Acasă", href: "/" },
      { name: "Pompe", href: "/categorie/pompe" },
    ]) as { itemListElement: { position: number; item: string }[] };
    expect(ld.itemListElement.map((e) => [e.position, e.item])).toEqual([
      [1, "https://magazin.test/"],
      [2, "https://magazin.test/categorie/pompe"],
    ]);
  });

  it("ItemList respectă decalajul paginii", () => {
    const ld = itemList(BASE, [{ name: "A", href: "/produs/a" }], 24) as {
      itemListElement: { position: number; url: string }[];
    };
    expect(ld.itemListElement[0]).toMatchObject({
      position: 25,
      url: "https://magazin.test/produs/a",
    });
  });
});

describe("productLd", () => {
  const base = {
    base: BASE,
    href: "/produs/pompa",
    name: "Pompă",
    description: "Descriere",
    images: ["https://cdn.test/a.webp"],
    brand: "AstralPool",
    currency: "RON",
  };

  it("o variantă: o ofertă cu prețul afișat, moneda, disponibilitatea și adresa canonică", () => {
    const ld = productLd({
      ...base,
      variants: [{ sku: "S1", ean: "5901234123457", amount: 19900, availability: av("in_stock") }],
    });
    expect(ld).toMatchObject({
      "@type": "Product",
      name: "Pompă",
      sku: "S1",
      gtin: "5901234123457",
      brand: { name: "AstralPool" },
      offers: {
        "@type": "Offer",
        price: "199.00",
        priceCurrency: "RON",
        availability: "https://schema.org/InStock",
        url: "https://magazin.test/produs/pompa",
      },
    });
  });

  it("mai multe variante: câte o ofertă fiecare; fără imagini, brand sau descriere nu apar câmpuri goale", () => {
    const ld = productLd({
      ...base,
      images: [],
      brand: null,
      description: undefined,
      variants: [
        { sku: "A", ean: null, amount: 1000, availability: av("in_stock") },
        { sku: "B", ean: null, amount: 2000, availability: av("unavailable") },
      ],
    }) as { offers: unknown[] } & Record<string, unknown>;
    expect(ld.offers).toHaveLength(2);
    expect(ld).not.toHaveProperty("image");
    expect(ld).not.toHaveProperty("brand");
    expect(ld).not.toHaveProperty("description");
    expect(ld).not.toHaveProperty("gtin");
  });

  it("niciun câmp de cost nu poate apărea (intrarea nu are cost)", () => {
    const text = jsonLdText(
      productLd({
        ...base,
        variants: [{ sku: "S", ean: null, amount: 100, availability: av("in_stock") }],
      }),
    );
    expect(text).not.toMatch(/cost/i);
  });
});

describe("organizationLd / websiteLd", () => {
  it("Organization cu adresă și contact doar când există; WebSite cu SearchAction pe adresa reală", () => {
    const empty = organizationLd({
      base: BASE,
      name: "Magazin",
      legalName: "",
      logo: null,
      address: { street: "", city: "", county: "", postalCode: "", country: "RO" },
      phone: "",
      email: "",
    });
    expect(empty).not.toHaveProperty("address");
    expect(empty).not.toHaveProperty("contactPoint");
    const full = organizationLd({
      base: BASE,
      name: "Magazin",
      legalName: "Magazin SRL",
      logo: "https://cdn.test/logo.png",
      address: {
        street: "Str. 1",
        city: "București",
        county: "B",
        postalCode: "010101",
        country: "RO",
      },
      phone: "0700 000 000",
      email: "a@b.ro",
    });
    expect(full).toMatchObject({
      legalName: "Magazin SRL",
      address: { addressLocality: "București" },
      contactPoint: { telephone: "0700 000 000" },
    });
    expect(websiteLd(BASE, "Magazin")).toMatchObject({
      potentialAction: {
        target: { urlTemplate: "https://magazin.test/cautare?q={search_term_string}" },
      },
    });
  });
});
