import { classifyHref } from "@ecom/core";
import { describe, expect, it } from "vitest";
import { normalizeEditorHref } from "./editor-link";

describe("normalizeEditorHref (adresa unui link din editor)", () => {
  it.each([
    ["https://exemplu.ro/x?a=1", "https://exemplu.ro/x?a=1"],
    ["http://exemplu.ro", "http://exemplu.ro"],
    ["  https://exemplu.ro/x  ", "https://exemplu.ro/x"],
    ["mailto:contact@exemplu.ro", "mailto:contact@exemplu.ro"],
    ["tel:+40712345678", "tel:+40712345678"],
    ["/produse/pompe", "/produse/pompe"],
    ["exemplu.ro/fisa", "https://exemplu.ro/fisa"],
    ["www.exemplu.ro", "https://www.exemplu.ro"],
    ["Exemplu.RO/Fisa", "https://Exemplu.RO/Fisa"],
  ])("%j → %j", (raw, expected) => {
    expect(normalizeEditorHref(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "file:///etc/passwd",
    "ftp://exemplu.ro/x",
    "//evil.example/x",
    "\\evil.example",
    "exemplu",
    "exemplu.ro/a b",
    "https://exem plu.ro",
    "a@exemplu.ro",
    "#ancora",
    "pagina",
    "https://",
    "mailto:",
    "tel:abc",
  ])("%j → refuzat", (raw) => {
    expect(normalizeEditorHref(raw)).toBeNull();
  });

  it("un link acceptat de editor este întotdeauna păstrat și de server (aceeași regulă ca sanitizatorul)", () => {
    const samples = [
      "https://exemplu.ro/x",
      "http://exemplu.ro",
      "exemplu.ro/fisa",
      "www.exemplu.ro",
      "mailto:a@b.ro",
      "mailto:a b@b.ro",
      "tel:+40 712 345 678",
      "tel:+40712345678",
      "/cale",
      "/cale cu spații",
      "//evil.example",
      "javascript:alert(1)",
      "https://exemplu.ro/​x",
      "https://exemplu.ro/" + "a".repeat(2100),
      "https://",
    ];
    for (const raw of samples) {
      const normalized = normalizeEditorHref(raw);
      if (normalized === null) continue;
      expect(classifyHref(normalized)?.value, raw).toBe(normalized);
    }
  });
});
