import { describe, expect, it } from "vitest";
import { dropTarget, stepTarget, zoneFromOffset, type TreeRow } from "./category-dnd";

const row = (over: Partial<TreeRow> & { id: string }): TreeRow => ({
  parentId: null,
  index: 0,
  siblingCount: 3,
  validParentIds: [null],
  ...over,
});

describe("zoneFromOffset", () => {
  it("sus, mijloc, jos", () => {
    expect(zoneFromOffset(2, 40)).toBe("before");
    expect(zoneFromOffset(20, 40)).toBe("inside");
    expect(zoneFromOffset(38, 40)).toBe("after");
    expect(zoneFromOffset(0, 0)).toBe("inside");
  });
});

describe("dropTarget", () => {
  it("în interior: devine copil, la sfârșit", () => {
    const dragged = row({ id: "a", validParentIds: [null, "b"] });
    const over = row({ id: "b" });
    expect(dropTarget(dragged, over, "inside")).toEqual({ parentId: "b", index: undefined });
  });

  it("deasupra/dedesubtul altei categorii: același părinte, poziția corectată după scoaterea sursei", () => {
    // frați: a(0) b(1) c(2); a trage după c → după scoatere: b(0) c(1) → index 2
    const a = row({ id: "a", index: 0 });
    const c = row({ id: "c", index: 2 });
    expect(dropTarget(a, c, "after")).toEqual({ parentId: null, index: 2 });
    // a înaintea lui c: index 1
    expect(dropTarget(a, c, "before")).toEqual({ parentId: null, index: 1 });
    // c trasă înaintea lui a: index 0
    expect(dropTarget(c, a, "before")).toEqual({ parentId: null, index: 0 });
    expect(dropTarget(c, a, "after")).toEqual({ parentId: null, index: 1 });
  });

  it("alt părinte: poziția e cea a țintei (fără corecție)", () => {
    const dragged = row({ id: "x", parentId: "p1", index: 0, validParentIds: [null, "p2"] });
    const over = row({ id: "y", parentId: "p2", index: 1 });
    expect(dropTarget(dragged, over, "before")).toEqual({ parentId: "p2", index: 1 });
    expect(dropTarget(dragged, over, "after")).toEqual({ parentId: "p2", index: 2 });
  });

  it("refuză: peste ea însăși și locuri care nu sunt permise (descendenți, prea adânc)", () => {
    const dragged = row({ id: "a", validParentIds: [null] });
    expect(dropTarget(dragged, dragged, "inside")).toBeNull();
    expect(dropTarget(dragged, row({ id: "descendent", parentId: "a" }), "inside")).toBeNull();
    expect(dropTarget(dragged, row({ id: "z" }), "inside")).toBeNull();
  });
});

describe("stepTarget", () => {
  it("sus și jos între frați; null la capete", () => {
    const middle = row({ id: "m", index: 1, parentId: "p" });
    expect(stepTarget(middle, "up")).toEqual({ parentId: "p", index: 0 });
    expect(stepTarget(middle, "down")).toEqual({ parentId: "p", index: 2 });
    expect(stepTarget(row({ id: "f", index: 0 }), "up")).toBeNull();
    expect(stepTarget(row({ id: "l", index: 2 }), "down")).toBeNull();
  });
});
