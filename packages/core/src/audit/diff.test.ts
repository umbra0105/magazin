import { describe, expect, it } from "vitest";
import { diffChanges } from "./diff";

describe("diffChanges", () => {
  it("întoarce doar căile schimbate, cu valoarea dinainte și de după", () => {
    expect(
      diffChanges({ a: 1, b: { c: 2, d: 3 }, e: [1, 2] }, { a: 1, b: { c: 9, d: 3 }, e: [1, 2] }),
    ).toEqual({ before: { "b.c": 2 }, after: { "b.c": 9 } });
  });

  it("nimic schimbat => null", () => {
    expect(diffChanges({ a: { b: 1 } }, { a: { b: 1 } })).toBeNull();
    expect(diffChanges(null, undefined)).toBeNull();
  });

  it("chei adăugate și scoase apar cu null de cealaltă parte", () => {
    expect(diffChanges({ a: 1 }, { b: 2 })).toEqual({
      before: { a: 1, b: null },
      after: { a: null, b: 2 },
    });
  });

  it("array-urile se compară întregi; Date după timp; valori primitive prin „value”", () => {
    expect(diffChanges({ l: [1, 2] }, { l: [1, 3] })).toEqual({
      before: { l: [1, 2] },
      after: { l: [1, 3] },
    });
    expect(diffChanges({ d: new Date(5) }, { d: new Date(5) })).toBeNull();
    expect(diffChanges(1, 2)).toEqual({ before: { value: 1 }, after: { value: 2 } });
  });

  it("creare (fără stare anterioară): toate câmpurile apar ca adăugate", () => {
    expect(diffChanges(undefined, { a: 1, b: { c: 2 } })).toEqual({
      before: { a: null, "b.c": null },
      after: { a: 1, "b.c": 2 },
    });
  });
});
