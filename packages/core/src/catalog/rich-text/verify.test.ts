import { describe, expect, it } from "vitest";
import { ORACLE_ATTRIBUTES } from "./oracle";
import { findRichHtmlViolations } from "./verify";

const MEDIA_ID = "cm0abcdef1234567890xyz";

/** Atribute care nu au loc pe nicio etichetă, în afara celor din lista albă a OPACULUI (scrisă independent). */
const FORBIDDEN_EVERYWHERE = [
  "onclick",
  "onerror",
  "onload",
  "style",
  "class",
  "id",
  "src",
  "srcset",
  "formaction",
  "tabindex",
  "contenteditable",
  "data-x",
  "href",
  "target",
  "rel",
  "title",
  "alt",
  "data-media-id",
  "colspan",
  "rowspan",
];

/** Un exemplu valid minimal pentru fiecare etichetă, în care adăugăm atributul de verificat. */
const sample = (tag: string, extra: string): string => {
  const base: Record<string, string> = {
    a: 'href="/x"',
    img: `alt="" data-media-id="${MEDIA_ID}"`,
  };
  const attributes = [base[tag], extra].filter(Boolean).join(" ");
  if (tag === "br" || tag === "hr") return `<${tag} ${attributes} />`;
  if (tag === "img") return `<img ${attributes} />`;
  return `<${tag} ${attributes}>x</${tag}>`;
};

describe("findRichHtmlViolations (a doua plasă, rulează pe ieșirea sanitizatorului)", () => {
  it("acceptă ieșiri curate", () => {
    for (const clean of [
      "<p>Text <strong>aldin</strong></p>",
      '<a href="https://exemplu.ro/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">t</a>',
      '<a href="/produse">t</a>',
      '<a href="mailto:a@b.ro">m</a><a href="tel:+40712345678">t</a>',
      `<p><img alt="x" data-media-id="${MEDIA_ID}" /></p>`,
      '<table><tr><td colspan="2" rowspan="20">x</td></tr></table>',
      "<p>a &lt; b &amp; c &gt; d</p>",
      "<hr /><br />",
    ]) {
      expect(findRichHtmlViolations(clean), clean).toEqual([]);
    }
  });

  it("pe fiecare etichetă permisă, orice atribut din afara listei ei albe (scrisă independent în oracol) e semnalat", () => {
    for (const [tag, allowed] of Object.entries(ORACLE_ATTRIBUTES)) {
      // exemplul cu atributele proprii e curat
      for (const own of allowed) {
        if (tag === "a" && (own === "href" || own === "target" || own === "rel")) continue;
        if (tag === "img") continue;
        const value = own === "colspan" || own === "rowspan" ? "2" : "x";
        expect(findRichHtmlViolations(sample(tag, `${own}="${value}"`)), `${tag}[${own}]`).toEqual(
          [],
        );
      }
      for (const forbidden of FORBIDDEN_EVERYWHERE) {
        if (allowed.includes(forbidden)) continue;
        // pe «a»/«img» atributul cerut de exemplu e deja în `base`; nu-l repetăm
        if (tag === "a" && forbidden === "href") continue;
        if (tag === "img" && (forbidden === "data-media-id" || forbidden === "alt")) continue;
        expect(
          findRichHtmlViolations(sample(tag, `${forbidden}="1"`)).length,
          `${tag}[${forbidden}] trebuie semnalat`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("rel greșit pe un link intern e semnalat (nu doar pe cele externe)", () => {
    expect(findRichHtmlViolations('<a href="/x" rel="opener">x</a>').length).toBeGreaterThan(0);
    expect(
      findRichHtmlViolations('<a href="mailto:a@b.ro" rel="noopener">x</a>').length,
    ).toBeGreaterThan(0);
    expect(findRichHtmlViolations('<a href="/x" rel="noopener noreferrer">x</a>')).toEqual([]);
  });

  it.each([
    ["script", "<script>alert(1)</script>"],
    ["iframe", "<iframe src=x></iframe>"],
    ["style", "<style>p{}</style>"],
    ["atribut de eveniment", '<p onclick="alert(1)">x</p>'],
    ["atribut style", '<p style="color:red">x</p>'],
    ["atribut class", '<p class="x">x</p>'],
    ["img cu src", '<img src="https://evil.example/x.png" alt="">'],
    ["img fără id media", '<img alt="x" />'],
    ["id media nevalid", '<img alt="" data-media-id="x" />'],
    [
      "href javascript",
      '<a href="javascript:alert(1)" target="_blank" rel="noopener noreferrer">x</a>',
    ],
    ["href data", '<a href="data:text/html,x" target="_blank" rel="noopener noreferrer">x</a>'],
    ["href relativ la protocol", '<a href="//evil.example/x">x</a>'],
    ["href cu spațiu", '<a href="/x y">x</a>'],
    ["link extern fără target și rel", '<a href="https://exemplu.ro/">x</a>'],
    [
      "link extern cu rel greșit",
      '<a href="https://exemplu.ro/" target="_blank" rel="opener">x</a>',
    ],
    ["target nepermis", '<a href="/x" target="_self">x</a>'],
    ["colspan nevalid", '<table><tr><td colspan="99">x</td></tr></table>'],
    ["«<» neescapat în text", "<p>a < b</p>"],
    ["«>» neescapat în text", "<p>a > b</p>"],
    ["atribut repetat", '<a href="/a" href="/b">x</a>'],
    ["atribute pe etichetă de închidere", '<p>x</p onclick="x">'],
    ["comentariu", "<!-- x --><p>a</p>"],
    ["atribut fără ghilimele", "<a href=/x>x</a>"],
  ])("semnalează: %s", (_name, dirty) => {
    expect(findRichHtmlViolations(dirty).length).toBeGreaterThan(0);
  });
});
