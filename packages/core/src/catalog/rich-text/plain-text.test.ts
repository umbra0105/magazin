import { describe, expect, it } from "vitest";
import { oracleViolations } from "./oracle";
import { plainTextToHtml, richTextToPlain } from "./plain-text";
import { sanitizeRichHtml } from "./sanitize";

describe("plainTextToHtml (descrierile vechi, text simplu → HTML sigur)", () => {
  it("împarte în paragrafe la liniile goale și pune <br /> la liniile simple", () => {
    expect(plainTextToHtml("a\n\nb")).toBe("<p>a</p><p>b</p>");
    expect(plainTextToHtml("a\nb")).toBe("<p>a<br />b</p>");
    expect(plainTextToHtml("a\nb\n\n\n\nc")).toBe("<p>a<br />b</p><p>c</p>");
  });

  it("escapează <, > și &, dar nu ghilimelele", () => {
    expect(plainTextToHtml('a < b & c > d "e"')).toBe('<p>a &lt; b &amp; c &gt; d "e"</p>');
    expect(plainTextToHtml("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
    expect(plainTextToHtml("&lt;")).toBe("<p>&amp;lt;</p>");
  });

  it("normalizează sfârșiturile de linie și taie capetele", () => {
    expect(plainTextToHtml("\r\n\r\n a\r\nb\r\n\r\n")).toBe("<p> a<br />b</p>");
    expect(plainTextToHtml("a\rb")).toBe("<p>a<br />b</p>");
  });

  it("păstrează liniile «- » și «Etichetă: valoare» ca text pe linii", () => {
    expect(plainTextToHtml("Putere: 5 kW\n- unu\n- doi")).toBe(
      "<p>Putere: 5 kW<br />- unu<br />- doi</p>",
    );
  });

  it("o linie cu doar spațiu de nerupere NU e goală (clasa de spații e explicit ASCII, ca în SQL)", () => {
    expect(plainTextToHtml("a\n\u00a0\nb")).toBe("<p>a<br />\u00a0<br />b</p>");
  });

  it("text gol sau doar spații → null", () => {
    for (const empty of ["", " ", "\n\n", " \t \r\n "]) expect(plainTextToHtml(empty)).toBeNull();
  });

  it("rezultatul e curat pentru oracol și stabil la sanitizare (punct fix)", () => {
    for (const text of [
      "simplu",
      "a\nb\n\nc",
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
      "a < b & c > d",
      "&lt;b&gt; &amp;amp;",
      "Șurub ț ă î â — „ghilimele”",
      '"><svg onload=alert(1)>',
    ]) {
      const converted = plainTextToHtml(text) as string;
      expect(oracleViolations(converted), text).toEqual([]);
      expect(sanitizeRichHtml(converted).html, text).toBe(converted);
    }
  });
});

describe("richTextToPlain (text derivat: SEO, căutare, feed-uri)", () => {
  it("paragrafele se separă prin linie goală, <br> prin linie nouă", () => {
    expect(richTextToPlain("<p>Salut</p><p>lume</p>")).toBe("Salut\n\nlume");
    expect(richTextToPlain("<p>a<br />b</p>")).toBe("a\nb");
  });

  it("listele devin linii cu «- »", () => {
    expect(richTextToPlain("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(richTextToPlain("<ol><li>a</li></ol>")).toBe("- a");
  });

  it("tabelele: două celule → «Etichetă: valoare», trei sau mai multe → «a | b | c», una → text", () => {
    expect(
      richTextToPlain(
        "<table><tbody><tr><td>Putere</td><td>5 kW</td></tr><tr><td>Debit</td><td>12 m³/h</td></tr></tbody></table>",
      ),
    ).toBe("Putere: 5 kW\nDebit: 12 m³/h");
    expect(richTextToPlain("<table><tr><th>A</th><th>B</th><th>C</th></tr></table>")).toBe(
      "A | B | C",
    );
    expect(richTextToPlain("<table><tr><td>Doar</td></tr></table>")).toBe("Doar");
  });

  it("decodează entitățile și nu lasă etichete", () => {
    expect(richTextToPlain("<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>")).toBe(
      'a & b < c > d "e"',
    );
    expect(richTextToPlain('<p>a <strong>b</strong> <a href="/x">c</a></p>')).toBe("a b c");
  });

  it("imaginile nu lasă text; conținutul ostil nu iese ca etichetă", () => {
    expect(richTextToPlain('<p>a</p><img alt="x" data-media-id="cm0abcdef1234567890xyz" />')).toBe(
      "a",
    );
    expect(richTextToPlain("<script>alert(1)</script>x")).toBe("x");
    for (const block of [
      "<iframe>text</iframe>",
      "<svg><text>text</text></svg>",
      "<form><p>text</p></form>",
      "<video>text</video>",
      "<math><mi>text</mi></math>",
      "<template>text</template>",
      "<noscript>text</noscript>",
      "<object>text</object>",
    ]) {
      expect(richTextToPlain(`a${block}b`), block).toBe("ab");
    }
    expect(richTextToPlain("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe(
      "<script>alert(1)</script>",
    );
  });

  it("null sau gol → șir gol", () => {
    expect(richTextToPlain(null)).toBe("");
    expect(richTextToPlain("")).toBe("");
    expect(richTextToPlain("<p> </p>")).toBe("");
  });

  it("limita de lungime taie cu «…» la capăt", () => {
    expect(richTextToPlain("<p>abcdefghij</p>", 5)).toBe("abcd…");
    expect(richTextToPlain("<p>abc</p>", 5)).toBe("abc");
  });
});
