import { describe, expect, it } from "vitest";
import { productTitleSize, tileSpan } from "./storefront-layout";

describe("mărimea titlului de produs", () => {
  it("scade treptat cu lungimea", () => {
    expect(productTitleSize("Pompă de filtrare")).toBe("text-2xl sm:text-3xl");
    expect(productTitleSize("x".repeat(61))).toBe("text-xl sm:text-2xl");
    expect(productTitleSize("x".repeat(111))).toBe("text-lg sm:text-xl");
  });
  it("limitele sunt exacte: 60 rămâne mare, 110 rămâne la treapta mijlocie", () => {
    expect(productTitleSize("x".repeat(60))).toBe("text-2xl sm:text-3xl");
    expect(productTitleSize("x".repeat(110))).toBe("text-xl sm:text-2xl");
  });
});

describe("plăcile de categorie umplu rândurile", () => {
  const spans = (
    count: number,
    prefix: "col-span-2" | "lg:col-span-6" | "lg:col-span-3" | "lg:col-span-2",
  ) =>
    Array.from({ length: count }, (_, i) => tileSpan(i, count)).filter((s) =>
      s.split(" ").includes(prefix),
    ).length;

  it("pe 6 coloane suma lățimilor e multiplu de 6 pentru orice număr de plăci", () => {
    for (let count = 1; count <= 12; count++) {
      const total = Array.from({ length: count }, (_, i) => {
        const wide = tileSpan(i, count)
          .split(" ")
          .find((c) => c.startsWith("lg:col-span-")) as string;
        return Number(wide.replace("lg:col-span-", ""));
      }).reduce((a, b) => a + b, 0);
      expect(total % 6, `${count} plăci`).toBe(0);
    }
  });
  it("pe 2 coloane o placă rămasă singură se întinde", () => {
    expect(spans(5, "col-span-2")).toBe(1);
    expect(spans(6, "col-span-2")).toBe(0);
    expect(tileSpan(4, 5)).toContain("col-span-2");
  });
});
