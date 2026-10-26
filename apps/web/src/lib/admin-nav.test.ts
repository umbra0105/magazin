import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, can, type PermissionSubject } from "@ecom/core";
import type { FeatureKey } from "@ecom/core";
import {
  ADMIN_NAV,
  CATALOG_ITEMS,
  activeItemId,
  breadcrumbsFor,
  itemHref,
  navEntryForPath,
  pathInGroup,
  visibleItems,
  visibleNav,
  type AdminNavEntry,
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

const visibilityFor = (roleKey: string, enabled: FeatureKey[] = []) => {
  const subject = subjectFor(roleKey);
  return {
    can: (p: Parameters<typeof can>[1]) => can(subject, p),
    isEnabled: (f: FeatureKey) => enabled.includes(f),
  };
};

const idsFor = (roleKey: string, enabled: FeatureKey[] = []) =>
  visibleNav(ADMIN_NAV, visibilityFor(roleKey, enabled)).map((e) => e.id);

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

  it("ascunde intrările fără permisiune: Suport nu vede catalogul, setări, utilizatori, audit", () => {
    const ids = idsFor("support");
    expect(ids).toEqual(expect.arrayContaining(["dashboard", "orders", "customers"]));
    for (const hidden of ["catalog", "settings", "users", "audit", "reports", "discounts"]) {
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
  it("tot ce e sub /admin/produse aparține grupului «Catalog»", () => {
    for (const path of [
      "/admin/produse",
      "/admin/produse/stoc",
      "/admin/produse/nou",
      "/admin/produse/cm123",
      "/admin/produse/import/istoric",
    ]) {
      expect(navEntryForPath(path)?.id, path).toBe("catalog");
    }
  });
});

describe("pathInGroup: grupul se deschide singur pe paginile lui", () => {
  it("adresa grupului și tot ce e sub ea; nu confundă prefixe de nume", () => {
    expect(pathInGroup("/admin/produse", "/admin/produse")).toBe(true);
    expect(pathInGroup("/admin/produse/stoc/abc", "/admin/produse")).toBe(true);
    expect(pathInGroup("/admin/produse/nou", "/admin/produse")).toBe(true);
    expect(pathInGroup("/admin/produsele", "/admin/produse")).toBe(false);
    expect(pathInGroup("/admin/media", "/admin/produse")).toBe(false);
    expect(pathInGroup("/admin", "/admin/produse")).toBe(false);
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
      section === "allProducts" ? (raw === "nou" ? "Produs nou" : "Editare produs") : null;
    expect(breadcrumbsFor("/admin/produse/nou", label, "Panou", undefined, labeler)).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:catalog", href: "/admin/produse" },
      { label: "L:allProducts", href: "/admin/produse" },
      { label: "Produs nou", href: null },
    ]);
    expect(breadcrumbsFor("/admin/produse/cm123", label, "Panou", undefined, labeler)[3]).toEqual({
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

const itemIdsFor = (roleKey: string, enabled: FeatureKey[] = []) =>
  visibleItems(CATALOG_ITEMS, visibilityFor(roleKey, enabled)).map((t) => t.id);

describe("grupul «Catalog»: o singură intrare de meniu, ecranele ca sub-elemente", () => {
  it("meniul are un singur grup pentru tot ce ține de catalog; Media rămâne separată", () => {
    const ids = ADMIN_NAV.map((e) => e.id);
    for (const moved of [
      "allProducts",
      "products",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
      "partsDiagrams",
      "inventory",
    ]) {
      expect(ids, moved).not.toContain(moved);
    }
    expect(ids.filter((id) => id === "catalog")).toHaveLength(1);
    expect(ids).toContain("media");
    expect(ADMIN_NAV.find((e) => e.id === "media")?.children).toBeUndefined();
  });

  it("sub-elementele, în ordinea cerută, toate sub /admin/produse, fiecare cu adresă proprie", () => {
    expect(CATALOG_ITEMS.map((t) => t.id)).toEqual([
      "allProducts",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
      "partsDiagrams",
      "inventory",
    ]);
    expect(CATALOG_ITEMS.map((t) => t.href)).toEqual([
      "/admin/produse",
      "/admin/produse/categorii",
      "/admin/produse/branduri",
      "/admin/produse/atribute",
      "/admin/produse/unitati-de-masura",
      "/admin/produse/fise-explodate",
      "/admin/produse/stoc",
    ]);
    expect(ADMIN_NAV.find((e) => e.id === "catalog")?.children).toBe(CATALOG_ITEMS);
    // grupul stă între Comenzi și Clienți, unde era intrarea «Produse»
    const order = ADMIN_NAV.map((e) => e.id);
    expect(order.indexOf("catalog")).toBe(order.indexOf("orders") + 1);
    expect(order.indexOf("customers")).toBe(order.indexOf("catalog") + 1);
  });

  it("Owner, Admin, Manager și Depozit văd toate elementele (Fișele explodate doar cu flag-ul pornit)", () => {
    for (const role of ["owner", "admin", "manager", "warehouse"]) {
      expect(itemIdsFor(role), role).toEqual([
        "allProducts",
        "categories",
        "brands",
        "attributes",
        "measureUnits",
        "inventory",
      ]);
      expect(itemIdsFor(role, ["partsDiagrams"]), role).toEqual([
        "allProducts",
        "categories",
        "brands",
        "attributes",
        "measureUnits",
        "partsDiagrams",
        "inventory",
      ]);
    }
  });

  it("Editorul vede elementele catalogului, dar nu Stoc (nu are inventory.read)", () => {
    expect(itemIdsFor("editor")).toEqual([
      "allProducts",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
    ]);
  });

  it("Suportul și Contabilul nu văd niciun element, deci nici grupul «Catalog»", () => {
    for (const role of ["support", "accountant"]) {
      expect(itemIdsFor(role), role).toEqual([]);
      expect(idsFor(role, ["partsDiagrams"]), role).not.toContain("catalog");
    }
  });

  it("grupul păstrează doar elementele vizibile și rămâne activ pe tot prefixul lui", () => {
    const entry = (roleKey: string) =>
      visibleNav(ADMIN_NAV, visibilityFor(roleKey)).find((e) => e.id === "catalog");
    expect(entry("owner")?.basePath).toBe("/admin/produse");
    expect(entry("owner")?.children?.map((c) => c.id)).toEqual([
      "allProducts",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
      "inventory",
    ]);
    // un rol doar cu inventory.read: grupul apare, cu un singur element (Stoc)
    const onlyInventory = { can: (p: string) => p === "inventory.read", isEnabled: () => false };
    const e = visibleNav(ADMIN_NAV, onlyInventory as never).find((x) => x.id === "catalog");
    expect(e?.basePath).toBe("/admin/produse");
    expect(e?.children?.map((t) => t.id)).toEqual(["inventory"]);
    expect(e?.href).toBe("/admin/produse/stoc");
  });

  it("fiecare element apare doar cu dreptul lui: pe rând, fiecare permisiune arată exact elementele ei", () => {
    const only = (permission: string, features: FeatureKey[] = []) =>
      visibleNav(ADMIN_NAV, {
        can: (p) => p === permission,
        isEnabled: (f) => features.includes(f),
      })
        .find((x) => x.id === "catalog")
        ?.children?.map((t) => t.id);
    expect(only("products.read")).toEqual([
      "allProducts",
      "categories",
      "brands",
      "attributes",
      "measureUnits",
    ]);
    expect(only("products.read", ["partsDiagrams"])).toContain("partsDiagrams");
    expect(only("inventory.read")).toEqual(["inventory"]);
    expect(only("orders.read")).toBeUndefined();
  });

  it("un rol fără niciun drept de catalog nu primește grupul, chiar cu toate flag-urile pornite", () => {
    const none = { can: () => false, isEnabled: () => true };
    expect(visibleNav(ADMIN_NAV, none).some((e) => e.id === "catalog")).toBe(false);
  });

  it("flag-ul partsDiagrams ascunde «Fișe explodate» și dacă are dreptul", () => {
    const all = { can: () => true, isEnabled: () => false };
    const ids = visibleNav(ADMIN_NAV, all)
      .find((e) => e.id === "catalog")
      ?.children?.map((t) => t.id);
    expect(ids).not.toContain("partsDiagrams");
    const withFlag = { can: () => true, isEnabled: (f: FeatureKey) => f === "partsDiagrams" };
    expect(
      visibleNav(ADMIN_NAV, withFlag)
        .find((e) => e.id === "catalog")
        ?.children?.map((t) => t.id),
    ).toContain("partsDiagrams");
  });

  it("elementul activ: potrivire pe prefix; editorul, produsul nou și importul țin «Produse» evidențiat", () => {
    expect(activeItemId("/admin/produse", CATALOG_ITEMS)).toBe("allProducts");
    expect(activeItemId("/admin/produse/stoc", CATALOG_ITEMS)).toBe("inventory");
    expect(activeItemId("/admin/produse/stoc/abc123", CATALOG_ITEMS)).toBe("inventory");
    expect(activeItemId("/admin/produse/categorii", CATALOG_ITEMS)).toBe("categories");
    expect(activeItemId("/admin/produse/fise-explodate/x", CATALOG_ITEMS)).toBe("partsDiagrams");
    // paginile de produs: editor, produs nou, import, istoricul importurilor
    for (const path of [
      "/admin/produse/nou",
      "/admin/produse/cm123",
      "/admin/produse/import",
      "/admin/produse/import/istoric",
      "/admin/produse/import/istoric/abc",
    ]) {
      expect(activeItemId(path, CATALOG_ITEMS), path).toBe("allProducts");
    }
    // un nume care doar începe la fel ca un element NU e acel element
    expect(activeItemId("/admin/produse/stocuri", CATALOG_ITEMS)).toBe("allProducts");
    expect(activeItemId("/admin/produse/categorii-vechi", CATALOG_ITEMS)).toBe("allProducts");
    // în afara grupului nu e evidențiat nimic
    expect(activeItemId("/admin/media", CATALOG_ITEMS)).toBeUndefined();
    expect(activeItemId("/admin", CATALOG_ITEMS)).toBeUndefined();
    expect(activeItemId("/admin/produsele", CATALOG_ITEMS)).toBeUndefined();
  });

  it("un singur element e evidențiat odată, și când elementul permis lipsește din listă", () => {
    // Editorul nu vede Stoc: pe o adresă de stoc (pagina îl refuză oricum) rămâne evidențiat «Produse»
    const editorItems = visibleItems(CATALOG_ITEMS, visibilityFor("editor"));
    expect(activeItemId("/admin/produse/stoc", editorItems)).toBe("allProducts");
  });

  it("fiecare element cere o permisiune din catalog", () => {
    const known = new Set(DEFAULT_ROLES.flatMap((r) => r.permissions));
    for (const item of CATALOG_ITEMS) expect(known.has(item.permission), item.id).toBe(true);
  });
});

describe("logica de grup e generică: aceleași reguli pentru orice alt grup (Comenzi, Clienți…)", () => {
  // grup sintetic, cu id-uri existente ca substituenți: dovedește că regulile nu sunt legate de «Catalog»
  const entries: readonly AdminNavEntry[] = [
    { id: "dashboard", href: "/admin" },
    {
      id: "customers",
      href: "/admin/clienti",
      children: [
        {
          id: "reviews",
          href: "/admin/clienti/recenzii",
          permission: "content.read",
          feature: "reviews",
        },
        { id: "discounts", href: "/admin/clienti", permission: "discounts.read" },
      ],
    },
    {
      id: "orders",
      href: "/admin/comenzi",
      children: [{ id: "reports", href: "/admin/comenzi/rapoarte", permission: "reports.read" }],
    },
  ];
  const vis = (granted: string[], features: FeatureKey[] = []) => ({
    can: (p: string) => granted.includes(p),
    isEnabled: (f: FeatureKey) => features.includes(f),
  });

  it("grupul apare doar dacă are cel puțin un element vizibil și le păstrează pe cele permise", () => {
    expect(
      visibleNav(entries, vis(["discounts.read"] as never)).map((e) => [e.id, e.children?.length]),
    ).toEqual([
      ["dashboard", undefined],
      ["customers", 1],
    ]);
    const both = visibleNav(
      entries,
      vis(["discounts.read", "content.read", "reports.read"] as never, ["reviews"]),
    );
    expect(both.find((e) => e.id === "customers")?.children?.map((c) => c.id)).toEqual([
      "reviews",
      "discounts",
    ]);
    expect(both.map((e) => e.id)).toContain("orders");
    // fără niciun drept: ambele grupuri dispar
    expect(visibleNav(entries, vis([])).map((e) => e.id)).toEqual(["dashboard"]);
  });

  it("flag-ul unui element îl ascunde chiar cu dreptul; grupul rămâne cu celelalte", () => {
    const ids = visibleNav(entries, vis(["content.read", "discounts.read"] as never))
      .find((e) => e.id === "customers")
      ?.children?.map((c) => c.id);
    expect(ids).toEqual(["discounts"]);
  });

  it("elementul activ și apartenența la grup funcționează pe alte adrese", () => {
    const customers = entries.find((e) => e.id === "customers");
    expect(activeItemId("/admin/clienti/recenzii/7", customers?.children ?? [])).toBe("reviews");
    expect(activeItemId("/admin/clienti/55", customers?.children ?? [])).toBe("discounts");
    expect(pathInGroup("/admin/clienti/55", "/admin/clienti")).toBe(true);
    expect(pathInGroup("/admin/comenzi", "/admin/clienti")).toBe(false);
  });

  it("firimiturile merg la fel: Panou › grup › element › segment", () => {
    const label = (id: string) => `L:${id}`;
    expect(breadcrumbsFor("/admin/clienti/recenzii/7", label, "Panou", entries)).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:customers", href: "/admin/clienti" },
      { label: "L:reviews", href: "/admin/clienti/recenzii" },
      { label: "7", href: null },
    ]);
  });
});

describe("breadcrumbsFor pe grupul «Catalog»", () => {
  const label = (id: string) => `L:${id}`;
  it("Panou › Catalog › Stoc pentru elementul Stoc", () => {
    expect(breadcrumbsFor("/admin/produse/stoc", label, "Panou")).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:catalog", href: "/admin/produse" },
      { label: "L:inventory", href: null },
    ]);
  });
  it("lista de produse: Panou › Catalog › Produse", () => {
    expect(breadcrumbsFor("/admin/produse", label, "Panou")).toEqual([
      { label: "Panou", href: "/admin" },
      { label: "L:catalog", href: "/admin/produse" },
      { label: "L:allProducts", href: null },
    ]);
  });
  it("segmentele de după element primesc id-ul elementului ca secțiune", () => {
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
    expect(crumbs.map((c) => c.label)).toEqual(["Panou", "L:catalog", "L:inventory", "Istoric"]);
    expect(crumbs[2]?.href).toBe("/admin/produse/stoc");
  });
  it("editorul de produs: Panou › Catalog › Produse › segment, cu «Produse» ca secțiune", () => {
    const seen: (string | null)[] = [];
    const crumbs = breadcrumbsFor("/admin/produse/cm123", label, "Panou", undefined, (section) => {
      seen.push(section);
      return null;
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Panou", "L:catalog", "L:allProducts", "cm123"]);
    expect(crumbs[2]?.href).toBe("/admin/produse");
    expect(seen).toEqual(["allProducts"]);
  });
});

describe("itemHref: filtrele din adresă se păstrează doar între ecrane care le înțeleg", () => {
  const byId = (id: string) => CATALOG_ITEMS.find((item) => item.id === id)!;
  const params = (q: string) => new URLSearchParams(q);
  it("căutarea (q) trece între «Produse» și «Stoc», în ambele sensuri", () => {
    expect(itemHref(byId("inventory"), byId("allProducts"), params("q=liner"))).toBe(
      "/admin/produse/stoc?q=liner",
    );
    expect(itemHref(byId("allProducts"), byId("inventory"), params("q=pompa"))).toBe(
      "/admin/produse?q=pompa",
    );
  });
  it("celelalte filtre și pagina se resetează la schimbarea elementului", () => {
    expect(
      itemHref(byId("inventory"), byId("allProducts"), params("q=a&stare=draft&pagina=3")),
    ).toBe("/admin/produse/stoc?q=a");
    expect(itemHref(byId("inventory"), byId("allProducts"), params("stare=draft&pagina=3"))).toBe(
      "/admin/produse/stoc",
    );
  });
  it("căutarea dintr-un element care nu o folosește pentru produse nu se duce în altul", () => {
    expect(itemHref(byId("inventory"), byId("categories"), params("q=x"))).toBe(
      "/admin/produse/stoc",
    );
    expect(itemHref(byId("categories"), byId("inventory"), params("q=x"))).toBe(
      "/admin/produse/categorii",
    );
    expect(itemHref(byId("brands"), byId("allProducts"), params("q=x"))).toBe(
      "/admin/produse/branduri",
    );
  });
  it("fără element curent (în afara grupului) nu se duce nimic; valoarea se codifică", () => {
    expect(itemHref(byId("inventory"), undefined, params("q=x"))).toBe("/admin/produse/stoc");
    expect(itemHref(byId("inventory"), byId("allProducts"), params("q=a%26b+c"))).toBe(
      "/admin/produse/stoc?q=a%26b+c",
    );
  });
});
