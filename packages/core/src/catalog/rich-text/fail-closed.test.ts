import { beforeEach, describe, expect, it, vi } from "vitest";

// A doua plasă: dacă verificarea finală găsește ceva în ieșirea sanitizatorului (de exemplu după o
// regresie a bibliotecii), rezultatul NU se întoarce ca HTML, ci ca text escapat, cu semnalul `failedClosed`.
const violations = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("./verify", () => ({
  findRichHtmlViolations: () => violations.list,
}));

import { sanitizeRichHtml } from "./sanitize";

describe("sanitizeRichHtml — eșec închis", () => {
  beforeEach(() => {
    violations.list = [];
  });

  it("fără încălcări, rezultatul e HTML-ul sanitizat", () => {
    const result = sanitizeRichHtml("<p>a <strong>b</strong></p>");
    expect(result.html).toBe("<p>a <strong>b</strong></p>");
    expect(result.stats.failedClosed).toBe(false);
  });

  it("cu o încălcare, întoarce textul ca paragrafe escapate, fără nicio etichetă din intrare", () => {
    violations.list = ["etichetă nepermisă: script"];
    const result = sanitizeRichHtml(
      "<p>Salut</p><p>lume <b>mare</b> &amp; <img src=x onerror=alert(1)></p>",
    );
    expect(result.stats.failedClosed).toBe(true);
    expect(result.html).toBe("<p>Salut</p><p>lume mare &amp;</p>");
    expect(result.mediaIds).toEqual([]);
  });

  it("textul din fallback e escapat chiar dacă intrarea cere altfel", () => {
    violations.list = ["x"];
    const result = sanitizeRichHtml("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(result.html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(result.stats.failedClosed).toBe(true);
  });

  it("dacă nici textul nu rămâne, descrierea e goală (null)", () => {
    violations.list = ["x"];
    expect(sanitizeRichHtml("<script>alert(1)</script>").html).toBeNull();
  });
});
