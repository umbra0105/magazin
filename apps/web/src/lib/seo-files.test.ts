import { describe, expect, it } from "vitest";
import {
  ROBOTS_DISALLOWED,
  SITEMAP_MAX_URLS,
  escapeXml,
  renderLlmsTxt,
  renderRobots,
  renderSitemap,
} from "./seo-files";

describe("escapeXml", () => {
  it("scapă caracterele speciale XML", () => {
    expect(escapeXml(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
  });
});

describe("renderSitemap", () => {
  const date = new Date("2030-01-02T03:04:05Z");

  it("adresă cu lastmod real și imaginea principală; fără priority și changefreq", () => {
    const xml = renderSitemap([
      {
        loc: "https://m.test/produs/a?x=1&y=2",
        lastmod: date,
        image: { loc: "https://cdn.test/a.webp", title: "Pompă <A>" },
      },
      { loc: "https://m.test/magazin" },
    ]);
    expect(xml).toContain("<loc>https://m.test/produs/a?x=1&amp;y=2</loc>");
    expect(xml).toContain("<lastmod>2030-01-02T03:04:05.000Z</lastmod>");
    expect(xml).toContain("<image:loc>https://cdn.test/a.webp</image:loc>");
    expect(xml).toContain("<image:title>Pompă &lt;A&gt;</image:title>");
    expect(xml).not.toContain("priority");
    expect(xml).not.toContain("changefreq");
    // o adresă fără lastmod nu primește unul inventat
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it("nu depășește limita de adrese a unui fișier", () => {
    const many = Array.from({ length: SITEMAP_MAX_URLS + 5 }, (_, i) => ({
      loc: `https://m.test/${i}`,
    }));
    expect(renderSitemap(many).match(/<url>/g)).toHaveLength(SITEMAP_MAX_URLS);
  });
});

describe("renderRobots", () => {
  it("blochează zonele private și căutarea internă, trimite la sitemap", () => {
    const text = renderRobots("https://m.test/");
    for (const path of ["/admin", "/cont", "/cos", "/checkout", "/cautare", "/autentificare"]) {
      expect(text).toContain(`Disallow: ${path}`);
    }
    expect(text).toContain("Sitemap: https://m.test/sitemap.xml");
    expect(ROBOTS_DISALLOWED).toContain("/comanda");
    // catalogul nu e blocat
    expect(text).not.toMatch(/Disallow: \/(produs|categorie|magazin|brand)/);
  });
});

describe("renderLlmsTxt", () => {
  it("doar din datele primite, cu adrese absolute", () => {
    const text = renderLlmsTxt({
      base: "https://m.test",
      storeName: "Magazin",
      tagline: "Echipamente",
      categories: [{ name: "Pompe", path: "pompe" }],
      brands: [{ name: "Acme", slug: "acme" }],
    });
    expect(text).toContain("# Magazin");
    expect(text).toContain("> Echipamente");
    expect(text).toContain("[Pompe](https://m.test/categorie/pompe)");
    expect(text).toContain("[Acme](https://m.test/brand/acme)");
    expect(text).toContain("https://m.test/sitemap.xml");
  });

  it("fără fraza magazinului și fără mărci nu apar secțiuni goale", () => {
    const text = renderLlmsTxt({
      base: "https://m.test",
      storeName: "M",
      tagline: "",
      categories: [],
      brands: [],
    });
    expect(text).not.toContain(">");
    expect(text).not.toContain("## Mărci");
  });
});
