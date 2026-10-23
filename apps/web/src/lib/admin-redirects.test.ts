import { describe, expect, it } from "vitest";
import { PRODUCT_TABS } from "./admin-nav";
import { LEGACY_ADMIN_ROUTES, legacyAdminRedirects } from "./admin-redirects";

describe("redirecturile adreselor vechi de admin", () => {
  it("fiecare adresă veche duce permanent (308) la tabul nou, păstrând restul căii", () => {
    expect(legacyAdminRedirects()).toEqual(
      LEGACY_ADMIN_ROUTES.map(({ from, to }) => ({
        source: `${from}/:path*`,
        destination: `${to}/:path*`,
        permanent: true,
      })),
    );
  });

  it("acoperă exact cele șase adrese mutate", () => {
    expect(LEGACY_ADMIN_ROUTES).toEqual([
      { from: "/admin/categorii", to: "/admin/produse/categorii" },
      { from: "/admin/branduri", to: "/admin/produse/branduri" },
      { from: "/admin/atribute", to: "/admin/produse/atribute" },
      { from: "/admin/unitati-de-masura", to: "/admin/produse/unitati-de-masura" },
      { from: "/admin/fise-explodate", to: "/admin/produse/fise-explodate" },
      { from: "/admin/stoc", to: "/admin/produse/stoc" },
    ]);
  });

  it("destinația fiecărei redirecționări e un tab real al grupului Produse", () => {
    const tabHrefs = new Set(PRODUCT_TABS.map((tab) => tab.href));
    for (const { to } of LEGACY_ADMIN_ROUTES) expect(tabHrefs.has(to), to).toBe(true);
  });

  it("nicio adresă veche nu mai e un tab și nicio sursă nu se repetă", () => {
    const tabHrefs = new Set(PRODUCT_TABS.map((tab) => tab.href));
    const sources = LEGACY_ADMIN_ROUTES.map((r) => r.from);
    for (const from of sources) expect(tabHrefs.has(from), from).toBe(false);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
