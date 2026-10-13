import { describe, expect, it } from "vitest";
import { effectiveMax, normalizeInitial, toggleSelection } from "./media-selection";

describe("toggleSelection", () => {
  it("păstrează ordinea alegerii", () => {
    let ids: string[] = [];
    for (const id of ["c", "a", "b"]) ids = toggleSelection(ids, id, 5).ids;
    expect(ids).toEqual(["c", "a", "b"]);
  });

  it("a doua apăsare deselectează, restul rămân în ordine", () => {
    expect(toggleSelection(["c", "a", "b"], "a", 5).ids).toEqual(["c", "b"]);
  });

  it("peste maxim: respinge fără să schimbe nimic", () => {
    const out = toggleSelection(["a", "b"], "c", 2);
    expect(out).toEqual({ ids: ["a", "b"], rejected: true });
  });

  it("după o deselectare se poate adăuga din nou, la sfârșit", () => {
    const afterRemove = toggleSelection(["a", "b"], "a", 2).ids;
    expect(toggleSelection(afterRemove, "c", 2).ids).toEqual(["b", "c"]);
  });

  it("selecție unică: alegerea nouă o înlocuiește pe cea veche", () => {
    expect(toggleSelection(["a"], "b", 1).ids).toEqual(["b"]);
    expect(toggleSelection(["b"], "b", 1).ids).toEqual([]);
  });
});

describe("effectiveMax / normalizeInitial", () => {
  it("unică = 1; multiplă = max configurat (implicit 10, între 1 și 50)", () => {
    expect(effectiveMax("single", 8)).toBe(1);
    expect(effectiveMax("multiple", undefined)).toBe(10);
    expect(effectiveMax("multiple", 3)).toBe(3);
    expect(effectiveMax("multiple", 0)).toBe(1);
    expect(effectiveMax("multiple", 500)).toBe(50);
    expect(effectiveMax("multiple", Number.NaN)).toBe(10);
  });

  it("selecția inițială: fără dubluri, în ordine, tăiată la maxim", () => {
    expect(normalizeInitial(["a", "b", "a", "c", "d"], 3)).toEqual(["a", "b", "c"]);
    expect(normalizeInitial(undefined, 3)).toEqual([]);
  });
});
