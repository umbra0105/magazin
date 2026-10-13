import { describe, expect, it } from "vitest";
import { normalizeAlt, normalizeFolderName, normalizeTags } from "./tags";
import { MediaUsageRegistry } from "./usage";

describe("normalizeTags", () => {
  it("litere mici, fără dubluri, spații curățate, diacritice păstrate", () => {
    expect(normalizeTags([" Piscină ", "piscină", "FILTRU   nisip", "", "  "])).toEqual([
      "piscină",
      "filtru nisip",
    ]);
  });

  it("respinge caractere periculoase, taguri lungi și prea multe taguri", () => {
    expect(() => normalizeTags(["<b>"])).toThrow();
    expect(() => normalizeTags(["a;b"])).toThrow();
    expect(() => normalizeTags(["x".repeat(31)])).toThrow();
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow();
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe("normalizeAlt / normalizeFolderName", () => {
  it("curăță spațiile și limitează lungimea", () => {
    expect(normalizeAlt("  Pompă   de căldură ")).toBe("Pompă de căldură");
    expect(() => normalizeAlt("a".repeat(301))).toThrow();
    expect(normalizeFolderName("  Piscine  mari ")).toBe("Piscine mari");
    expect(() => normalizeFolderName("a/b")).toThrow();
    expect(() => normalizeFolderName("a\\b")).toThrow();
    expect(() => normalizeFolderName("")).toThrow();
  });
});

describe("MediaUsageRegistry", () => {
  const provider = (name: string, map: Record<string, string[]>) => ({
    name,
    findUsages: async (ids: readonly string[]) =>
      new Map(
        ids
          .filter((id) => map[id])
          .map((id) => [id, (map[id] ?? []).map((label) => ({ kind: name, label }))]),
      ),
  });

  it("fără provideri: nimic folosit", async () => {
    expect((await new MediaUsageRegistry().findUsages(["a"])).size).toBe(0);
  });

  it("adună locurile de la toți providerii și ignoră id-urile nefolosite", async () => {
    const registry = new MediaUsageRegistry();
    registry.register(provider("product", { a: ["Pompa 1"], b: ["Liner"] }));
    registry.register(provider("page", { a: ["Acasă"] }));
    const out = await registry.findUsages(["a", "b", "c"]);
    expect(out.get("a")?.map((u) => u.label)).toEqual(["Pompa 1", "Acasă"]);
    expect(out.get("b")?.map((u) => u.label)).toEqual(["Liner"]);
    expect(out.has("c")).toBe(false);
  });

  it("înregistrarea e idempotentă pe nume", () => {
    const registry = new MediaUsageRegistry();
    registry.register(provider("product", {}));
    registry.register(provider("product", {}));
    expect(registry.size).toBe(1);
  });

  it("un provider care aruncă propagă eroarea (fail-closed)", async () => {
    const registry = new MediaUsageRegistry();
    registry.register({
      name: "x",
      findUsages: async () => {
        throw new Error("căzut");
      },
    });
    await expect(registry.findUsages(["a"])).rejects.toThrow("căzut");
  });
});
