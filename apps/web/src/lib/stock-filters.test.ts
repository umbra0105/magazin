import { describe, expect, it } from "vitest";
import { activeStockFilters } from "./stock-filters";

/** Etichetele eliminabile de sub bara de filtre (docs/17 §4.1): doar filtrele active, fiecare cu legătura care îl scoate. */

describe("activeStockFilters", () => {
  it("fără filtre nu există etichete", () => {
    expect(activeStockFilters({})).toEqual([]);
    expect(activeStockFilters({ page: 3, pageSize: 50 })).toEqual([]);
  });

  it("căutarea, tipul și starea: etichetă în română + legătura fără acel filtru, pe prima pagină", () => {
    const filters = activeStockFilters({
      search: "liner",
      kind: "managed",
      state: "limited",
      page: 4,
    });
    expect(filters.map((x) => x.label)).toEqual([
      "Căutare: liner",
      "Tip: Gestionat",
      "Stare: Stoc limitat",
    ]);
    expect(filters.map((x) => x.href)).toEqual([
      "/admin/produse/stoc?tip=managed&stare=limited",
      "/admin/produse/stoc?q=liner&stare=limited",
      "/admin/produse/stoc?q=liner&tip=managed",
    ]);
    expect(filters.map((x) => x.key)).toEqual(["search", "kind", "state"]);
  });

  it("păstrează vederea, depozitul și rândurile pe pagină la eliminare", () => {
    const [filter] = activeStockFilters({
      search: "liner",
      lowStockOnly: true,
      warehouseCode: "nord",
      pageSize: 50,
    });
    expect(filter?.href).toBe("/admin/produse/stoc?filtru=stoc-mic&depozit=nord&pe-pagina=50");
  });

  it("vederea «Stoc mic» și motivul nu sunt etichete (sunt tab-ul și cardurile)", () => {
    expect(activeStockFilters({ lowStockOnly: true, reason: "out_of_stock" })).toEqual([]);
  });

  it("fiecare etichetă are nume accesibil care spune ce face", () => {
    const [filter] = activeStockFilters({ kind: "digital" });
    expect(filter?.removeLabel).toBe("Elimină filtrul Tip: Digital");
  });
});
