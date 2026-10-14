import { describe, expect, it } from "vitest";
import {
  childrenOf,
  descendantIds,
  MAX_CATEGORY_DEPTH,
  planMove,
  planRename,
  subtreeHeight,
  validateMove,
  validParents,
  type CategoryNode,
} from "./category-tree";

function node(
  id: string,
  parentId: string | null,
  depth: number,
  path: string,
  sortOrder = 0,
  name = id,
): CategoryNode {
  return { id, parentId, slug: path.split("/").at(-1) as string, name, path, depth, sortOrder };
}

/**
 *  piscine (0)
 *   ├─ pompe (1)
 *   │   └─ pompe-filtrare (2)
 *   │       └─ cartuse (3)
 *   └─ chimicale (1)
 *  accesorii (0)
 */
const tree: CategoryNode[] = [
  node("piscine", null, 0, "piscine", 0),
  node("accesorii", null, 0, "accesorii", 1),
  node("pompe", "piscine", 1, "piscine/pompe", 0),
  node("chimicale", "piscine", 1, "piscine/chimicale", 1),
  node("filtrare", "pompe", 2, "piscine/pompe/filtrare", 0),
  node("cartuse", "filtrare", 3, "piscine/pompe/filtrare/cartuse", 0),
];

describe("structura arborelui", () => {
  it("descendenți, înălțimea subarborelui și frații în ordine", () => {
    expect([...descendantIds(tree, "piscine")].sort()).toEqual(
      ["cartuse", "chimicale", "filtrare", "pompe"].sort(),
    );
    expect(subtreeHeight(tree, "piscine")).toBe(3);
    expect(subtreeHeight(tree, "cartuse")).toBe(0);
    expect(childrenOf(tree, null).map((n) => n.id)).toEqual(["piscine", "accesorii"]);
  });
});

describe("validateMove", () => {
  it("refuză: categoria părinte a ei însăși", () => {
    expect(validateMove(tree, "pompe", "pompe")).toEqual({
      ok: false,
      code: "CATEGORY_SELF_PARENT",
    });
  });

  it("refuză ciclurile: sub un descendent direct sau indirect", () => {
    expect(validateMove(tree, "piscine", "pompe")).toEqual({ ok: false, code: "CATEGORY_CYCLE" });
    expect(validateMove(tree, "piscine", "cartuse")).toEqual({ ok: false, code: "CATEGORY_CYCLE" });
    expect(validateMove(tree, "pompe", "cartuse")).toEqual({ ok: false, code: "CATEGORY_CYCLE" });
  });

  it("refuză părinte inexistent și categorie inexistentă", () => {
    expect(validateMove(tree, "pompe", "nu-exista")).toEqual({
      ok: false,
      code: "CATEGORY_PARENT_NOT_FOUND",
    });
    expect(validateMove(tree, "nu-exista", null)).toEqual({
      ok: false,
      code: "CATEGORY_NOT_FOUND",
    });
  });

  it("adâncimea maximă ține cont de subarbore: pompe (înălțime 2) nu intră sub un nod de adâncime 3", () => {
    expect(MAX_CATEGORY_DEPTH).toBe(4);
    // „cartuse” (adâncime 3) ca părinte → pompe ar ajunge la 4, cu copii la 5 și 6
    const deep = [...tree, node("x", null, 0, "x")];
    expect(validateMove(deep, "x", "cartuse")).toEqual({ ok: true, newDepth: 4 });
    expect(validateMove(deep, "accesorii", "cartuse")).toEqual({ ok: true, newDepth: 4 });
    // „piscine” are înălțime 3: sub „accesorii” (adâncime 0) ajunge la 1 + 3 = 4: permis
    expect(validateMove(tree, "piscine", "accesorii")).toEqual({ ok: true, newDepth: 1 });
    // o categorie cu înălțime 2 sub un nod de adâncime 3 depășește 4
    const withBranch = [
      ...tree,
      node("a", null, 0, "a"),
      node("a1", "a", 1, "a/a1"),
      node("a2", "a1", 2, "a/a1/a2"),
    ];
    expect(validateMove(withBranch, "a", "cartuse")).toEqual({
      ok: false,
      code: "CATEGORY_TOO_DEEP",
    });
  });

  it("la rădăcină e mereu permis (dacă există)", () => {
    expect(validateMove(tree, "cartuse", null)).toEqual({ ok: true, newDepth: 0 });
  });

  it("validParents: exclude categoria, descendenții și părinții prea adânci (alternativa de tastatură)", () => {
    const options = validParents(tree, "pompe");
    expect(options).toContain(null);
    expect(options).toContain("accesorii");
    expect(options).not.toContain("pompe");
    expect(options).not.toContain("filtrare");
    expect(options).not.toContain("cartuse");
  });
});

describe("planMove", () => {
  const byId = (updates: ReturnType<typeof planMove>) => new Map(updates.map((u) => [u.id, u]));

  it("mută subarborele: cale și adâncime recalculate pentru toți descendenții", () => {
    const updates = byId(planMove(tree, "pompe", "accesorii", 0));
    expect(updates.get("pompe")).toMatchObject({
      parentId: "accesorii",
      depth: 1,
      path: "accesorii/pompe",
      sortOrder: 0,
    });
    expect(updates.get("filtrare")).toMatchObject({ depth: 2, path: "accesorii/pompe/filtrare" });
    expect(updates.get("cartuse")).toMatchObject({
      depth: 3,
      path: "accesorii/pompe/filtrare/cartuse",
    });
  });

  it("renumerotează vechii frați (fără gol) și pe cei noi (fără suprapunere)", () => {
    const updates = byId(planMove(tree, "pompe", null, 0));
    expect(updates.get("pompe")).toMatchObject({
      parentId: null,
      depth: 0,
      path: "pompe",
      sortOrder: 0,
    });
    // noii frați de la rădăcină se mută cu o poziție
    expect(updates.get("piscine")?.sortOrder).toBe(1);
    expect(updates.get("accesorii")?.sortOrder).toBe(2);
    // vechiul frate „chimicale” trece pe poziția 0
    expect(updates.get("chimicale")?.sortOrder).toBe(0);
  });

  it("reordonare în același părinte: nu schimbă căi, doar ordinea", () => {
    const updates = planMove(tree, "accesorii", null, 0);
    const map = byId(updates);
    expect(map.get("accesorii")).toMatchObject({ path: "accesorii", sortOrder: 0 });
    expect(map.get("piscine")?.sortOrder).toBe(1);
    expect(updates.every((u) => u.id === "accesorii" || u.id === "piscine")).toBe(true);
  });

  it("poziția în afara intervalului se limitează la capete", () => {
    expect(byId(planMove(tree, "accesorii", "piscine", 99)).get("accesorii")?.sortOrder).toBe(2);
    expect(byId(planMove(tree, "accesorii", "piscine", -5)).get("accesorii")?.sortOrder).toBe(0);
  });
});

describe("planRename", () => {
  it("schimbarea adresei recalculează calea lui și a descendenților, fără să schimbe adâncimea", () => {
    const updates = new Map(planRename(tree, "pompe", "pompe-apa").map((u) => [u.id, u]));
    expect(updates.get("pompe")).toMatchObject({ path: "piscine/pompe-apa", depth: 1 });
    expect(updates.get("filtrare")).toMatchObject({
      path: "piscine/pompe-apa/filtrare",
      depth: 2,
    });
    expect(updates.get("cartuse")?.path).toBe("piscine/pompe-apa/filtrare/cartuse");
    expect(updates.size).toBe(3);
  });
});
