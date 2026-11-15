import { describe, expect, it } from "vitest";
import { buildMenuTree, CATEGORY_URL_PREFIX, type MenuCategory } from "./menu";

const cat = (
  id: string,
  parentId: string | null,
  path: string,
  patch: Partial<MenuCategory> = {},
): MenuCategory => ({
  id,
  parentId,
  slug: path.split("/").at(-1) ?? path,
  name: patch.name ?? id,
  path,
  depth: path.split("/").length - 1,
  sortOrder: 0,
  productCount: 1,
  ...patch,
});

describe("buildMenuTree", () => {
  it("construiește arborele cu adrese reale: /categorie/<cale>", () => {
    const tree = buildMenuTree([cat("a", null, "pompe"), cat("b", "a", "pompe/de-caldura")], {
      maxLevels: 3,
    });
    expect(CATEGORY_URL_PREFIX).toBe("/categorie/");
    expect(tree).toEqual([
      {
        id: "a",
        name: "a",
        href: "/categorie/pompe",
        children: [{ id: "b", name: "b", href: "/categorie/pompe/de-caldura", children: [] }],
      },
    ]);
  });

  it("ordinea: sortOrder, apoi numele (în română)", () => {
    const tree = buildMenuTree(
      [
        cat("z", null, "z", { name: "Țevi", sortOrder: 1 }),
        cat("y", null, "y", { name: "Filtre", sortOrder: 0 }),
        cat("x", null, "x", { name: "Acoperiri", sortOrder: 0 }),
      ],
      { maxLevels: 3 },
    );
    expect(tree.map((n) => n.name)).toEqual(["Acoperiri", "Filtre", "Țevi"]);
  });

  it("ascunde categoriile fără produse active în tot subarborele; păstrează părintele gol cu un copil plin", () => {
    const tree = buildMenuTree(
      [
        cat("p", null, "p", { productCount: 0 }),
        cat("c", "p", "p/c", { productCount: 3 }),
        cat("empty", null, "empty", { productCount: 0 }),
        cat("e2", "empty", "empty/e2", { productCount: 0 }),
      ],
      { maxLevels: 3 },
    );
    expect(tree.map((n) => n.id)).toEqual(["p"]);
    expect(tree[0]?.children.map((n) => n.id)).toEqual(["c"]);
  });

  it("taie la numărul de niveluri cerut (nivelul 1 = doar rădăcinile)", () => {
    const rows = [cat("a", null, "a"), cat("b", "a", "a/b"), cat("c", "b", "a/b/c")];
    expect(buildMenuTree(rows, { maxLevels: 1 })[0]?.children).toEqual([]);
    expect(buildMenuTree(rows, { maxLevels: 2 })[0]?.children[0]?.children).toEqual([]);
    expect(buildMenuTree(rows, { maxLevels: 3 })[0]?.children[0]?.children).toHaveLength(1);
  });

  it("un copil cu părinte necunoscut nu devine rădăcină (date incoerente nu strică meniul)", () => {
    const tree = buildMenuTree([cat("o", "lipsa", "x/o")], { maxLevels: 3 });
    expect(tree).toEqual([]);
  });

  it("numele cu caractere speciale rămân text (nu se interpretează aici)", () => {
    const tree = buildMenuTree([cat("a", null, "a", { name: "<b>Filtre</b> & pompe" })], {
      maxLevels: 3,
    });
    expect(tree[0]?.name).toBe("<b>Filtre</b> & pompe");
  });
});
