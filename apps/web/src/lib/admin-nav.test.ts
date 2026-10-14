import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, can, type PermissionSubject } from "@ecom/core";
import type { FeatureKey } from "@ecom/core";
import { ADMIN_NAV, breadcrumbsFor, navEntryForPath, visibleNav } from "./admin-nav";

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
