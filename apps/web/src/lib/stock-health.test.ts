import { describe, expect, it } from "vitest";
import { stockHealthView } from "./stock-health";

/** Bara de stoc segmentată (Panou și Stoc): din numărătorile «Stoc mic» și numărul de variante gestionate. */

const counts = (over: Partial<Parameters<typeof stockHealthView>[0]> = {}) => ({
  outOfStock: 3,
  remainderOnly: 1,
  belowThreshold: 2,
  ...over,
});
const none = { outOfStock: 0, remainderOnly: 0, belowThreshold: 0 };

describe("stockHealthView", () => {
  it("în stoc = gestionate − la stoc mic; stoc mic = sub prag; epuizat = epuizate + doar rest nevandabil", () => {
    const view = stockHealthView(counts(), 20);
    expect(view?.segments).toEqual([
      { key: "in-stock", label: "În stoc", value: 14, tone: "ok" },
      { key: "low", label: "Stoc mic", value: 2, tone: "low" },
      { key: "out", label: "Epuizat", value: 4, tone: "out" },
    ]);
    expect(view?.label).toBe("Starea stocului");
  });

  it("segmentele însumează exact variantele gestionate (nimic numărat de două ori sau pierdut)", () => {
    for (const [c, managed] of [
      [counts(), 20],
      [counts(none), 5],
      [counts({ outOfStock: 3, remainderOnly: 0, belowThreshold: 0 }), 3],
    ] as const) {
      const view = stockHealthView(c, managed);
      expect(view?.segments.reduce((sum, seg) => sum + seg.value, 0)).toBe(managed);
    }
  });

  it("legenda spune pe câte variante gestionate se bazează, cu plural românesc", () => {
    const caption = (n: number) => stockHealthView(counts(none), n)?.caption;
    expect(caption(1)).toBe("1 variantă gestionată");
    expect(caption(2)).toBe("2 variante gestionate");
    expect(caption(19)).toBe("19 variante gestionate");
    expect(caption(20)).toBe("20 de variante gestionate");
    expect(caption(1234)).toBe("1.234 de variante gestionate");
  });

  it("fără variante gestionate nu există bară (nimic de arătat, nu o bară goală)", () => {
    expect(stockHealthView(counts(none), 0)).toBeNull();
  });

  it("numere incoerente (mai multe la stoc mic decât gestionate) nu dau «în stoc» negativ", () => {
    expect(stockHealthView(counts(), 4)?.segments[0]?.value).toBe(0);
  });
});
