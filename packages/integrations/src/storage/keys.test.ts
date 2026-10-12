import { describe, expect, it } from "vitest";
import { buildKey, isPublicKey, visibilityOf } from "./keys";
import { StorageError } from "./types";

describe("chei de storage", () => {
  it("vizibilitatea vine din primul segment", () => {
    expect(visibilityOf("public/media/2026/10/a1b2.avif")).toBe("public");
    expect(visibilityOf("private/digital/curs-1/lectia-1.mp4")).toBe("private");
    expect(isPublicKey("public/x.png")).toBe(true);
    expect(isPublicKey("private/x.png")).toBe(false);
  });

  it("buildKey asamblează și validează", () => {
    expect(buildKey("public", "media", "2026", "a.jpg")).toBe("public/media/2026/a.jpg");
    expect(() => buildKey("private", "..", "x")).toThrow(StorageError);
  });

  const malicious = [
    "",
    "public",
    "public/",
    "/public/x.jpg",
    "public//x.jpg",
    "public/x.jpg/",
    "../public/x.jpg",
    "public/../private/x.jpg",
    "public/./x.jpg",
    "public/a/../../../etc/passwd",
    "public\\x.jpg",
    "public/a\\..\\b.jpg",
    "public/x\0.jpg",
    "public/%2e%2e/x.jpg",
    "public/..%2fx.jpg",
    "public/x y.jpg",
    "public/ș.jpg",
    "public/x.jpg.",
    "public/CON",
    "public/nul.txt",
    "public/c:/windows/x",
    "public/x.meta.json",
    "PUBLIC/x.jpg",
    "media/x.jpg",
    "uploads/public/x.jpg",
    `public/${"a".repeat(600)}`,
  ];

  it.each(malicious)("respinge cheia periculoasă %j", (key) => {
    expect(() => visibilityOf(key)).toThrowError(StorageError);
    try {
      visibilityOf(key);
    } catch (error) {
      expect((error as StorageError).code).toBe("STORAGE_INVALID_KEY");
      // cheia nu apare în mesaj (poate veni din date nesigure)
      if (key.length > 6) expect((error as StorageError).message).not.toContain(key);
    }
  });
});
