import { describe, expect, it } from "vitest";
import { categoryHref, listingHref, productHref } from "./storefront-urls";

describe("adresele catalogului", () => {
  it("produsul și categoria au adrese simple", () => {
    expect(productHref("pompa-12")).toBe("/produs/pompa-12");
    expect(categoryHref("pompe/filtrare")).toBe("/categorie/pompe/filtrare");
  });

  it("valorile implicite nu apar în adresă: prima pagină și sortarea implicită au forma canonică fără parametri", () => {
    expect(listingHref("/magazin")).toBe("/magazin");
    expect(listingHref("/magazin", { sort: "recommended", page: 1 })).toBe("/magazin");
  });

  it("sortarea și pagina se scriu când diferă de implicit", () => {
    expect(listingHref("/magazin", { sort: "price_asc" })).toBe("/magazin?sortare=price_asc");
    expect(listingHref("/magazin", { page: 3 })).toBe("/magazin?pagina=3");
    expect(listingHref("/categorie/pompe", { sort: "new", page: 2 })).toBe(
      "/categorie/pompe?sortare=new&pagina=2",
    );
  });
});
