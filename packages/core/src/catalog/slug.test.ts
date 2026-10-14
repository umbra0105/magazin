import { describe, expect, it } from "vitest";
import { generateUniqueSlug, isValidSlug, slugify, SLUG_MAX_LENGTH } from "./slug";

describe("slugify", () => {
  it("scoate diacriticele românești și normalizează separatorii", () => {
    expect(slugify("Pompă de căldură aer-apă 12 kW")).toBe("pompa-de-caldura-aer-apa-12-kw");
    expect(slugify("Șemineu țuică & Îngheț")).toBe("semineu-tuica-inghet");
    expect(slugify("  --Filtru___nisip!!  ")).toBe("filtru-nisip");
  });

  it("acceptă și variantele cu sedilă (ş, ţ) și pe cele cu virgulă (ș, ț)", () => {
    expect(slugify("ş ţ ș ț")).toBe("s-t-s-t");
  });

  it("șir fără litere sau cifre → valoarea de rezervă; nu depășește lungimea maximă", () => {
    expect(slugify("!!!")).toBe("produs");
    expect(slugify("???", "categorie")).toBe("categorie");
    const long = slugify("a".repeat(300));
    expect(long.length).toBe(SLUG_MAX_LENGTH);
    expect(isValidSlug(slugify(`${"cuvânt ".repeat(40)}final`))).toBe(true);
  });

  it("rezultatul e mereu un slug valid", () => {
    for (const input of ["Ünïcödé", "x", "A B", "100%", "---a---", "tab\tnewline\n"]) {
      expect(isValidSlug(slugify(input)), input).toBe(true);
    }
  });
});

describe("isValidSlug", () => {
  it("acceptă doar litere mici, cifre și cratime simple", () => {
    for (const ok of ["a", "pompa-12", "a-b-c"]) expect(isValidSlug(ok), ok).toBe(true);
    for (const bad of ["", "-a", "a-", "a--b", "A", "a b", "ă", "a_b", "a".repeat(81)]) {
      expect(isValidSlug(bad), bad).toBe(false);
    }
  });
});

describe("generateUniqueSlug", () => {
  it("întoarce baza dacă e liberă", async () => {
    expect(await generateUniqueSlug("Pompă X", async () => false)).toBe("pompa-x");
  });

  it("adaugă sufix numeric la coliziune: -2, -3...", async () => {
    const taken = new Set(["pompa-x", "pompa-x-2"]);
    expect(await generateUniqueSlug("Pompă X", async (s) => taken.has(s))).toBe("pompa-x-3");
  });

  it("păstrează lungimea maximă chiar cu sufix", async () => {
    const base = "a".repeat(200);
    const taken = new Set([slugify(base)]);
    const slug = await generateUniqueSlug(base, async (s) => taken.has(s));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-2")).toBe(true);
    expect(isValidSlug(slug)).toBe(true);
  });

  it("se oprește cu o eroare clară dacă nu găsește o adresă liberă", async () => {
    await expect(generateUniqueSlug("x", async () => true, 5)).rejects.toMatchObject({
      code: "CATALOG_SLUG_EXHAUSTED",
    });
  });
});
