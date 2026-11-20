import { describe, expect, it } from "vitest";
import { breadcrumbsFor } from "./admin-nav";
import { detailCrumbLabel, type CrumbTexts } from "./admin-crumbs";

/**
 * Firimiturile paginilor de detaliu din grupul «Comenzi» (Faza 11, C4): ultima migă e NUMĂRUL comenzii sau al ofertei sau numele
 * șablonului, niciodată id-ul intern. Numărul vine de la pagină (după ce a citit comanda); până îl are, migă generică.
 */
const texts: CrumbTexts = {
  order: "Comandă",
  offer: "Ofertă",
  payment: "Plată",
  template: "Șablon",
  newOffer: "Ofertă nouă",
};
const nav = (id: string): string =>
  ({
    orders: "Comenzi",
    allOrders: "Toate comenzile",
    payments: "Plăți",
    offers: "Oferte de plată",
    emailTemplates: "Șabloane email",
    installRequests: "Cereri de instalare",
  })[id] ?? id;

const crumbsOf = (path: string, labels: Record<string, string> = {}) =>
  breadcrumbsFor(path, nav as never, "Panou", undefined, (section, raw, previous, href) =>
    detailCrumbLabel(section, raw, previous, href, labels, texts),
  ).map((crumb) => crumb.label);

describe("firimiturile detaliilor din «Comenzi»", () => {
  it("comanda: numărul înregistrat de pagină, nu id-ul intern", () => {
    const id = "cmwoom7rw0002bov9bn90qmlc";
    expect(crumbsOf(`/admin/comenzi/${id}`, { [`/admin/comenzi/${id}`]: "E2E-000900" })).toEqual([
      "Panou",
      "Comenzi",
      "Toate comenzile",
      "E2E-000900",
    ]);
  });

  it("oferta și plata: numărul ofertei (OF-0066), respectiv al comenzii plății", () => {
    expect(
      crumbsOf("/admin/comenzi/oferte/cmx1", { "/admin/comenzi/oferte/cmx1": "OF-0066" }).at(-1),
    ).toBe("OF-0066");
    expect(
      crumbsOf("/admin/comenzi/plati/cmp1", { "/admin/comenzi/plati/cmp1": "WEB-000123" }).at(-1),
    ).toBe("WEB-000123");
  });

  it("șablonul: numele lui, nu cheia tehnică", () => {
    expect(
      crumbsOf("/admin/comenzi/sabloane-email/order.confirmation", {
        "/admin/comenzi/sabloane-email/order.confirmation": "Confirmare comandă",
      }).at(-1),
    ).toBe("Confirmare comandă");
  });

  it("până când pagina înregistrează numărul, nicio migă nu arată id-ul: apare numele generic", () => {
    expect(crumbsOf("/admin/comenzi/cmwoom7rw0002bov9bn90qmlc").at(-1)).toBe("Comandă");
    expect(crumbsOf("/admin/comenzi/oferte/cmx1").at(-1)).toBe("Ofertă");
    expect(crumbsOf("/admin/comenzi/plati/cmp1").at(-1)).toBe("Plată");
    expect(crumbsOf("/admin/comenzi/sabloane-email/order.shipped").at(-1)).toBe("Șablon");
    for (const crumb of crumbsOf("/admin/comenzi/oferte/cmx1")) expect(crumb).not.toMatch(/cmx1/);
  });

  it("«Ofertă nouă» are eticheta ei; listele nu primesc etichetă de detaliu", () => {
    expect(crumbsOf("/admin/comenzi/oferte/nou").at(-1)).toBe("Ofertă nouă");
    expect(crumbsOf("/admin/comenzi/oferte")).toEqual(["Panou", "Comenzi", "Oferte de plată"]);
    expect(crumbsOf("/admin/comenzi")).toEqual(["Panou", "Comenzi", "Toate comenzile"]);
  });

  it("o etichetă înregistrată pentru altă adresă nu se aplică aici (pagina veche nu se scurge pe cea nouă)", () => {
    expect(
      crumbsOf("/admin/comenzi/idnou", { "/admin/comenzi/idvechi": "E2E-000001" }).at(-1),
    ).toBe("Comandă");
  });

  it("alte secțiuni rămân neatinse (editorul de produs, de exemplu)", () => {
    expect(
      detailCrumbLabel("allProducts", "cm1", null, "/admin/produse/cm1", {}, texts),
    ).toBeNull();
  });
});
