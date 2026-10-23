import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, can, type PermissionSubject } from "@ecom/core";
import type { FeatureKey } from "@ecom/core";
import {
  ADMIN_NAV,
  PRODUCT_TABS,
  activeTabId,
  breadcrumbsFor,
  navEntryForPath,
  tabHref,
  visibleNav,
  visibleTabs,
} from "./admin-nav";

const subjectFor = (roleKey: string): PermissionSubject => {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@test.invalid`,
    roles: [roleKey],
    permissions: new Set(role?.permissions ?? []),
  };
};

const idsFor = (roleKey: string, enabled: FeatureKey[] = []) => {
  const subject = subjectFor(roleKey);
  return visibleNav(ADMIN_NAV, {
    can: (p) => can(subject, p),
    isEnabled: (f) => enabled.includes(f),
  }).map((e) => e.id);
};

describe("visibleNav", () => {
  it("cu toate flag-urile oprite, funcțiile opționale lipsesc din meniu (Owner)", () => {
    const ids = idsFor("owner");
    for (const hidden of ["blog", "reviews", "loyalty", "vouchers"]) {
      expect(ids, hidden).not.toContain(hidden);
    }
    expect(ids).toContain("orders");
    expect(ids).toContain("users");
  });

  it("flag-ul pornit arată funcția; doar cea pornită", () => {
    const ids = idsFor("owner", ["blog"]);
    expect(ids).toContain("blog");
    expect(ids).not.toContain("reviews");
  });

  it("ascunde intrările fără permisiune: Suport nu vede produse, setări, utilizatori, audit", () => {
    const ids = idsFor("support");
    expect(ids).toEqual(expect.arrayContaining(["dashboard", "orders", "customers"]));
    for (const hidden of ["products", "settings", "users", "audit", "reports", "discounts"]) {
      expect(ids, hidden).not.toContain(hidden);
    }
  });

  it("permisiunea ȘI flag-ul trebuie să fie îndeplinite: Editor vede blogul doar cu flag pornit", () => {
    expect(idsFor("editor")).not.toContain("blog");
    expect(idsFor("editor", ["blog"])).toContain("blog");
    // Depozit nu are content.read: nu vede blogul nici cu flag pornit.
    expect(idsFor("warehouse", ["blog"])).not.toContain("blog");
  });

  it("Panoul e vizibil oricărui rol cu acces în admin", () => {
    for (const role of DEFAULT_ROLES) expect(idsFor(role.key), role.key).toContain("dashboard");
  });

  it("fiecare intrare cu permisiune folosește o permisiune din catalog", () => {
    const known = new Set(DEFAULT_ROLES.flatMap((r) => r.permissions));
    for (const entry of ADMIN_NAV) {
      if (entry.permission) expect(known.has(entry.permission), entry.id).toBe(true);
    }
  });
});

describe("navEntryForPath", () => {
  it("alege intrarea cu prefixul cel mai lung", () => {
    expect(navEntryForPath("/admin/comenzi/123")?.id).toBe("orders");
    expect(navEntryForPath("/admin")?.id).toBe("dashboard");
    expect(navEntryForPath("/admin/necunoscut")?.id).toBe("dashboard");
  });
  it("nu confundă prefixe de nume (/admin/comenzile)", () => {
    expect(navEntryForPath("/admin/comenzile")?.id).toBe("dashboard");
  });
});

describe("breadcrumbsFor", () => {
  const label = (id: string) => `L:${id}`;
  it("Panou pentru /admin, fără link pe ultima migă", () => {
    expect(breadcrumbsFor("/admin", label, "Panou")).toEqual([{ label: "Panou", href: null }]);
  });
  it("Panou › secțiune pentru o secțiune", () => {
    expect(breadcrumbsFor("/admin/comenzi", label, "Panou")).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:orders", href: null },
    ]);
  });
  it("Panou › secțiune › id, cu segmentul decodat și linkuri intermediare", () => {
    expect(breadcrumbsFor("/admin/comenzi/ABC%20123?x=1", label, "Panou")).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:orders", href: "/admin/comenzi" },
      { label: "ABC 123", href: null },
    ]);
  });
  it("un etichetator de segmente poate înlocui „nou” și id-urile tehnice", () => {
    const labeler = (section: string | null, raw: string) =>
      section === "products" ? (raw === "nou" ? "Produs nou" : "Editare produs") : null;
    expect(breadcrumbsFor("/admin/produse/nou", label, "Panou", undefined, labeler)).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:products", href: "/admin/produse" },
      { label: "Produs nou", href: null },
    ]);
    expect(breadcrumbsFor("/admin/produse/cm123", label, "Panou", undefined, labeler)[2]).toEqual({
      label: "Editare produs",
      href: null,
    });
    // alte secțiuni rămân neschimbate
    expect(breadcrumbsFor("/admin/comenzi/ABC", label, "Panou", undefined, labeler)[2]).toEqual({
      label: "ABC",
      href: null,
    });
  });
  it("în afara adminului nu produce firimituri; segment cu % invalid nu aruncă", () => {
    expect(breadcrumbsFor("/cont", label, "Panou")).toEqual([]);
    expect(() => breadcrumbsFor("/admin/comenzi/%E0%A4%A", label, "Panou")).not.toThrow();
  });
});

const visibilityFor = (roleKey: string, enabled: FeatureKey[] = []) => {
  const subject = subjectFor(roleKey);
  return {
    can: (p: Parameters<typeof can>[1]) => can(subject, p),
    isEnabled: (f: FeatureKey) => enabled.includes(f),
  };
};
const tabIdsFor = (roleKey: string, enabled: FeatureKey[] = []) =>
  visibleTabs(PRODUCT_TABS, visibilityFor(roleKey, enabled)).map((t) => t.id);

describe("grupul Produse: o singură intrare de meniu, ecranele ca taburi", () => {
  it("meniul are o singură intrare pentru tot ce ține de produse; Media rămâne separată", () => {
    const ids = ADMIN_NAV.map((e) => e.id);
    for (const moved of [
      "categories",
      "brands",
      "attributes",
      "measureUnits",
      "partsDiagrams",
      "inventory",
    ]) {
      expect(ids, moved).not.toContain(moved);
    }
    expect(ids.filter((id) => id === "products")).toHaveLength(1);
    expect(ids).toContain("media");
  });

  it("taburile, în ordinea cerută, toate sub /admin/produse, fiecare cu adresă proprie", () => {
    expect(PRODUCT_TABS.map((t) => t.id)).toEqual([
      "allProducts",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
      "partsDiagrams",
      "inventory",
    ]);
    expect(PRODUCT_TABS.map((t) => t.href)).toEqual([
      "/admin/produse",
      "/admin/produse/categorii",
      "/admin/produse/branduri",
      "/admin/produse/atribute",
      "/admin/produse/unitati-de-masura",
      "/admin/produse/fise-explodate",
      "/admin/produse/stoc",
    ]);
    expect(ADMIN_NAV.find((e) => e.id === "products")?.tabs).toBe(PRODUCT_TABS);
  });

  it("Owner, Admin, Manager și Depozit văd toate taburile (Fișele explodate doar cu flag-ul pornit)", () => {
    for (const role of ["owner", "admin", "manager", "warehouse"]) {
      expect(tabIdsFor(role), role).toEqual([
        "allProducts",
        "categories",
        "brands",
        "attributes",
        "measureUnits",
        "inventory",
      ]);
      expect(tabIdsFor(role, ["partsDiagrams"]), role).toContain("partsDiagrams");
    }
  });

  it("Editorul vede taburile catalogului, dar nu Stoc (nu are inventory.read)", () => {
    expect(tabIdsFor("editor")).toEqual([
      "allProducts",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
    ]);
  });

  it("Suportul și Contabilul nu văd niciun tab, deci nici intrarea «Produse»", () => {
    for (const role of ["support", "accountant"]) {
      expect(tabIdsFor(role), role).toEqual([]);
      expect(idsFor(role, ["partsDiagrams"]), role).not.toContain("products");
    }
  });

  it("intrarea «Produse» duce la primul tab permis și rămâne activă pe tot prefixul grupului", () => {
    const entry = (roleKey: string) =>
      visibleNav(ADMIN_NAV, visibilityFor(roleKey)).find((e) => e.id === "products");
    expect(entry("owner")?.href).toBe("/admin/produse");
    expect(entry("owner")?.basePath).toBe("/admin/produse");
    // un rol doar cu inventory.read: intrarea apare și duce la Stoc
    const onlyInventory = {
      can: (p: string) => p === "inventory.read",
      isEnabled: () => false,
    };
    const e = visibleNav(ADMIN_NAV, onlyInventory as never).find((x) => x.id === "products");
    expect(e?.href).toBe("/admin/produse/stoc");
    expect(e?.basePath).toBe("/admin/produse");
    expect(e?.tabs?.map((t) => t.id)).toEqual(["inventory"]);
  });

  it("un rol fără niciun drept de produse nu primește intrarea", () => {
    const none = { can: () => false, isEnabled: () => true };
    expect(visibleNav(ADMIN_NAV, none).some((e) => e.id === "products")).toBe(false);
  });

  it("tabul activ: potrivire pe prefix, iar «Toate produsele» doar pe adresa exactă", () => {
    expect(activeTabId("/admin/produse", PRODUCT_TABS)).toBe("allProducts");
    expect(activeTabId("/admin/produse/stoc", PRODUCT_TABS)).toBe("inventory");
    expect(activeTabId("/admin/produse/stoc/abc123", PRODUCT_TABS)).toBe("inventory");
    expect(activeTabId("/admin/produse/fise-explodate/x", PRODUCT_TABS)).toBe("partsDiagrams");
    // editorul de produs și importul nu sunt taburi
    expect(activeTabId("/admin/produse/nou", PRODUCT_TABS)).toBeUndefined();
    expect(activeTabId("/admin/produse/cm123", PRODUCT_TABS)).toBeUndefined();
    expect(activeTabId("/admin/produse/import", PRODUCT_TABS)).toBeUndefined();
    // nu confundă prefixe de nume
    expect(activeTabId("/admin/produse/stocuri", PRODUCT_TABS)).toBeUndefined();
  });

  it("fiecare tab cere o permisiune din catalog", () => {
    const known = new Set(DEFAULT_ROLES.flatMap((r) => r.permissions));
    for (const tab of PRODUCT_TABS) expect(known.has(tab.permission), tab.id).toBe(true);
  });
});

describe("breadcrumbsFor pe grupul Produse", () => {
  const label = (id: string) => `L:${id}`;
  it("Panou › Produse › Stoc pentru tabul Stoc, iar «Toate produsele» nu dublează «Produse»", () => {
    expect(breadcrumbsFor("/admin/produse/stoc", label, "Panou")).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:products", href: "/admin/produse" },
      { label: "L:inventory", href: null },
    ]);
    expect(breadcrumbsFor("/admin/produse", label, "Panou")).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:products", href: null },
    ]);
  });
  it("segmentele de după tab primesc id-ul tabului ca secțiune", () => {
    const seen: (string | null)[] = [];
    const crumbs = breadcrumbsFor(
      "/admin/produse/stoc/v1",
      label,
      "Panou",
      undefined,
      (section) => {
        seen.push(section);
        return "Istoric";
      },
    );
    expect(seen).toEqual(["inventory"]);
    expect(crumbs.map((c) => c.label)).toEqual(["Panou", "L:products", "L:inventory", "Istoric"]);
    expect(crumbs[2]?.href).toBe("/admin/produse/stoc");
  });
  it("editorul de produs rămâne sub «Produse», fără crumb de tab", () => {
    const crumbs = breadcrumbsFor("/admin/produse/cm123", label, "Panou");
    expect(crumbs.map((c) => c.label)).toEqual(["Panou", "L:products", "cm123"]);
  });
});

describe("tabHref: filtrele din adresă se păstrează doar între ecrane care le înțeleg", () => {
  const byId = (id: string) => PRODUCT_TABS.find((tab) => tab.id === id)!;
  const params = (q: string) => new URLSearchParams(q);
  it("căutarea (q) trece între «Toate produsele» și «Stoc», în ambele sensuri", () => {
    expect(tabHref(byId("inventory"), byId("allProducts"), params("q=liner"))).toBe(
      "/admin/produse/stoc?q=liner",
    );
    expect(tabHref(byId("allProducts"), byId("inventory"), params("q=pompa"))).toBe(
      "/admin/produse?q=pompa",
    );
  });
  it("celelalte filtre și pagina se resetează la schimbarea tabului", () => {
    expect(
      tabHref(byId("inventory"), byId("allProducts"), params("q=a&stare=draft&pagina=3")),
    ).toBe("/admin/produse/stoc?q=a");
    expect(tabHref(byId("inventory"), byId("allProducts"), params("stare=draft&pagina=3"))).toBe(
      "/admin/produse/stoc",
    );
  });
  it("căutarea dintr-un tab care nu o folosește pentru produse nu se duce în alt tab", () => {
    expect(tabHref(byId("inventory"), byId("categories"), params("q=x"))).toBe(
      "/admin/produse/stoc",
    );
    expect(tabHref(byId("categories"), byId("inventory"), params("q=x"))).toBe(
      "/admin/produse/categorii",
    );
    expect(tabHref(byId("brands"), byId("allProducts"), params("q=x"))).toBe(
      "/admin/produse/branduri",
    );
  });
  it("fără tab curent (editor, import) nu se duce nimic; valoarea se codifică", () => {
    expect(tabHref(byId("inventory"), undefined, params("q=x"))).toBe("/admin/produse/stoc");
    expect(tabHref(byId("inventory"), byId("allProducts"), params("q=a%26b+c"))).toBe(
      "/admin/produse/stoc?q=a%26b+c",
    );
  });
});
