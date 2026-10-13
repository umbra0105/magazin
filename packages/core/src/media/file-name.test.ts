import { describe, expect, it } from "vitest";
import { sanitizeFileName } from "./file-name";

describe("sanitizeFileName", () => {
  it("păstrează un nume normal și decodează percent-encoding", () => {
    expect(sanitizeFileName("pompa%20c%C4%83ldur%C4%83.jpg")).toBe("pompa căldură.jpg");
    expect(sanitizeFileName("liner-albastru.png")).toBe("liner-albastru.png");
  });

  it("scoate căile (/, \\) și punctele de la început", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\ion\\poza.jpg")).toBe("poza.jpg");
    expect(sanitizeFileName("...ascuns.jpg")).toBe("ascuns.jpg");
  });

  it("scoate caracterele de control, rezervate și de direcție (RTL)", () => {
    expect(sanitizeFileName('a\r\nb\u0000c<>:"|?*.jpg')).toBe("abc.jpg");
    expect(sanitizeFileName("poza\u202egpj.exe")).toBe("pozagpj.exe");
  });

  it("limitează lungimea păstrând extensia", () => {
    const out = sanitizeFileName(`${"a".repeat(400)}.jpeg`);
    expect(out.length).toBe(150);
    expect(out.endsWith(".jpeg")).toBe(true);
  });

  it("gol sau invalid → nume implicit", () => {
    expect(sanitizeFileName(null)).toBe("imagine");
    expect(sanitizeFileName("   ")).toBe("imagine");
    expect(sanitizeFileName("%E0%A4%A")).not.toBe("");
  });
});
