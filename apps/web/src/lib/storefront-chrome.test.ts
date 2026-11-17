import { containerWidthOf } from "@ecom/core";
import { describe, expect, it } from "vitest";
import {
  headerSlots,
  telHref,
  STOREFRONT_READINESS,
  FOOTER_INFO_LINKS,
  FOOTER_LEGAL_LINKS,
} from "./storefront-chrome-rules";

describe("headerSlots: elementele din header care aparțin fazelor viitoare", () => {
  it("căutarea (Faza 7) și coșul (Faza 8) sunt active; favoritele ascunse fără steag", () => {
    expect(headerSlots({ wishlistFlag: false, readiness: STOREFRONT_READINESS })).toEqual({
      search: "active",
      cart: "active",
      wishlist: "hidden",
    });
  });

  it("starea oficială de azi: căutarea și coșul sunt gata, favoritele nu", () => {
    expect(STOREFRONT_READINESS).toEqual({ search: true, cart: true, wishlist: false });
  });

  it("când faza e gata, elementul devine activ", () => {
    expect(
      headerSlots({
        wishlistFlag: false,
        readiness: { search: true, cart: true, wishlist: true },
      }),
    ).toEqual({ search: "active", cart: "active", wishlist: "hidden" });
  });

  it("favoritele: ascunse fără steag; cu steag dar fără funcție, dezactivate; cu ambele, active", () => {
    const base = { search: false, cart: false };
    expect(
      headerSlots({ wishlistFlag: false, readiness: { ...base, wishlist: true } }).wishlist,
    ).toBe("hidden");
    expect(
      headerSlots({ wishlistFlag: true, readiness: { ...base, wishlist: false } }).wishlist,
    ).toBe("disabled");
    expect(
      headerSlots({ wishlistFlag: true, readiness: { ...base, wishlist: true } }).wishlist,
    ).toBe("active");
  });
});

describe("containerWidthOf", () => {
  it("acceptă doar lg, xl, 2xl; orice altceva cade pe xl", () => {
    expect(containerWidthOf("lg")).toBe("lg");
    expect(containerWidthOf("xl")).toBe("xl");
    expect(containerWidthOf("2xl")).toBe("2xl");
    for (const bad of ["", "full", "XL", "72rem", 'x" onload="1', undefined as unknown as string]) {
      expect(containerWidthOf(bad), String(bad)).toBe("xl");
    }
  });
});

describe("telHref", () => {
  it("păstrează doar plusul de la început și cifrele", () => {
    expect(telHref("0700 000 000")).toBe("tel:0700000000");
    expect(telHref("+40 (700) 000-000")).toBe("tel:+40700000000");
  });

  it("nu produce legătură din text care nu e telefon (prea scurt sau fără cifre)", () => {
    for (const bad of ["", "   ", "abc", "12", "javascript:alert(1)"]) {
      expect(telHref(bad), bad).toBeNull();
    }
  });
});

describe("linkurile din footer", () => {
  it("adresele sunt cele din docs/03, cu o singură formă", () => {
    expect(FOOTER_LEGAL_LINKS.map((l) => l.href)).toEqual([
      "/termeni-si-conditii",
      "/politica-de-confidentialitate",
      "/politica-cookie-uri",
      "/politica-de-retur",
    ]);
    expect(FOOTER_INFO_LINKS.map((l) => l.href)).toEqual([
      "/livrare-si-plata",
      "/garantii",
      "/intrebari-frecvente",
      "/despre-noi",
      "/contact",
    ]);
  });

  it("toate încep cu / și nu au duplicate", () => {
    const all = [...FOOTER_LEGAL_LINKS, ...FOOTER_INFO_LINKS].map((l) => l.href);
    expect(new Set(all).size).toBe(all.length);
    for (const href of all) expect(href.startsWith("/")).toBe(true);
  });
});
