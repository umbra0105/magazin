import { describe, expect, it } from "vitest";
import { planCategoryRedirects, planSlugRedirects, redirectKey } from "./slug-redirect";

describe("redirectKey", () => {
  it("litere mici, fără spații la capete", () => {
    expect(redirectKey("  Pompe/Pompe-Filtrare ")).toBe("pompe/pompe-filtrare");
  });
});

describe("planSlugRedirects (produs, brand)", () => {
  it("o adresă schimbată lasă adresa veche spre entitate", () => {
    expect(planSlugRedirects("product", "p1", "pompa-veche", "pompa-noua")).toEqual({
      add: [{ kind: "product", oldKey: "pompa-veche", targetId: "p1" }],
      reclaim: ["pompa-noua"],
    });
  });

  it("aceeași adresă (chiar cu altă literă mare) nu produce nimic", () => {
    expect(planSlugRedirects("brand", "b1", "Acme", "acme")).toEqual({ add: [], reclaim: [] });
  });

  it("revenirea la o adresă veche o scoate din istoric (pagina vie câștigă)", () => {
    const plan = planSlugRedirects("product", "p1", "b", "a");
    expect(plan.reclaim).toContain("a");
    expect(plan.add.map((e) => e.oldKey)).toEqual(["b"]);
  });
});

describe("planCategoryRedirects", () => {
  const before = [
    { id: "c1", path: "pompe" },
    { id: "c2", path: "pompe/filtrare" },
    { id: "c3", path: "chimicale" },
  ];

  it("redenumirea unui părinte redirecționează părintele ȘI descendenții, nu și restul", () => {
    const after = [
      { id: "c1", path: "echipamente" },
      { id: "c2", path: "echipamente/filtrare" },
      { id: "c3", path: "chimicale" },
    ];
    expect(planCategoryRedirects(before, after)).toEqual({
      add: [
        { kind: "category", oldKey: "pompe", targetId: "c1" },
        { kind: "category", oldKey: "pompe/filtrare", targetId: "c2" },
      ],
      reclaim: ["echipamente", "echipamente/filtrare"],
    });
  });

  it("o mutare sub alt părinte schimbă calea, deci produce redirecționare", () => {
    const after = [
      { id: "c1", path: "pompe" },
      { id: "c2", path: "chimicale/filtrare" },
      { id: "c3", path: "chimicale" },
    ];
    expect(planCategoryRedirects(before, after).add).toEqual([
      { kind: "category", oldKey: "pompe/filtrare", targetId: "c2" },
    ]);
  });

  it("schimbul de căi între două categorii nu lasă redirecționări care ar umbri paginile vii", () => {
    const after = [
      { id: "c1", path: "chimicale" },
      { id: "c3", path: "pompe" },
    ];
    expect(planCategoryRedirects([before[0]!, before[2]!], after)).toEqual({
      add: [],
      reclaim: ["chimicale", "pompe"],
    });
  });

  it("fără schimbare de cale, nimic", () => {
    expect(planCategoryRedirects(before, before)).toEqual({ add: [], reclaim: [] });
  });
});
