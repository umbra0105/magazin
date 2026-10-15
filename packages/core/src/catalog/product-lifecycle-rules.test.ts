import { describe, expect, it } from "vitest";
import {
  copySkus,
  copyTitle,
  DUPLICATE_SKU_SUFFIX,
  DUPLICATE_TITLE_SUFFIX,
  hasCopySkuMarker,
  isSellable,
} from "./product-lifecycle-rules";
import { PRODUCT_TITLE_MAX_LENGTH, SKU_MAX_LENGTH } from "./product-schemas";

describe("copyTitle", () => {
  it("adaugă sufixul de copie", () => {
    expect(copyTitle("Pompă de căldură")).toBe(`Pompă de căldură${DUPLICATE_TITLE_SUFFIX}`);
  });

  it("taie titlul lung ca rezultatul să încapă în limită", () => {
    const out = copyTitle("x".repeat(PRODUCT_TITLE_MAX_LENGTH));
    expect(out).toHaveLength(PRODUCT_TITLE_MAX_LENGTH);
    expect(out.endsWith(DUPLICATE_TITLE_SUFFIX)).toBe(true);
  });
});

describe("copySkus", () => {
  const none = async () => [] as string[];

  it("pune sufixul de copie pe fiecare cod", async () => {
    expect(await copySkus(["PC-100", "PC-200"], none)).toEqual([
      `PC-100${DUPLICATE_SKU_SUFFIX}`,
      `PC-200${DUPLICATE_SKU_SUFFIX}`,
    ]);
  });

  it("trece la -COPIE-2, -COPIE-3 cât timp un candidat e deja luat (aceeași treaptă pentru toate)", async () => {
    const taken = new Set(["pc-100-copie", "pc-100-copie-2"]);
    const out = await copySkus(["PC-100", "PC-200"], async (c) =>
      c.filter((x) => taken.has(x.toLowerCase())),
    );
    expect(out).toEqual(["PC-100-COPIE-3", "PC-200-COPIE-3"]);
  });

  it("tăierea la limită nu poate produce coduri identice între ele", async () => {
    const base = "A".repeat(SKU_MAX_LENGTH - 2);
    const out = await copySkus([`${base}1`, `${base}2`], none);
    expect(new Set(out.map((s) => s.toLowerCase())).size).toBe(2);
    for (const sku of out) expect(sku.length).toBeLessThanOrEqual(SKU_MAX_LENGTH);
  });

  it("se oprește cu o eroare clară când nu găsește coduri libere", async () => {
    await expect(copySkus(["X"], async (c) => [...c])).rejects.toMatchObject({
      code: "CATALOG_SKU_CONFLICT",
    });
  });

  it("codurile generate sunt recunoscute ca „de completat”, cele obișnuite nu", async () => {
    const [first] = await copySkus(["PC-100"], none);
    expect(hasCopySkuMarker(first as string)).toBe(true);
    expect(hasCopySkuMarker("PC-100-COPIE-4")).toBe(true);
    expect(hasCopySkuMarker("pc-100-copie")).toBe(true);
    expect(hasCopySkuMarker("PC-100")).toBe(false);
    expect(hasCopySkuMarker("COPIE-PC")).toBe(false);
  });
});

describe("isSellable", () => {
  it("doar produsul activ și neșters se poate vinde", () => {
    expect(isSellable({ status: "active", deletedAt: null })).toBe(true);
    expect(isSellable({ status: "draft", deletedAt: null })).toBe(false);
    expect(isSellable({ status: "archived", deletedAt: null })).toBe(false);
    expect(isSellable({ status: "active", deletedAt: new Date() })).toBe(false);
  });
});
