import { ValidationError } from "@ecom/shared";
import { describe, expect, it } from "vitest";
import { ORACLE_ATTRIBUTES, oracleViolations } from "./oracle";
import { RICH_TEXT_LIMITS, sanitizeRichHtml } from "./sanitize";
import { XSS_VECTORS } from "./xss-vectors";

const MEDIA_ID = "cm0abcdef1234567890xyz";
const html = (input: string, options?: Parameters<typeof sanitizeRichHtml>[1]): string | null =>
  sanitizeRichHtml(input, options).html;

describe("sanitizeRichHtml — formatarea permisă", () => {
  it("păstrează paragrafele, formatarea, listele, citatele și titlurile", () => {
    const input =
      "<h2>Titlu</h2><p>Text <strong>aldin</strong>, <em>italic</em>, <u>subliniat</u>, <s>tăiat</s>, x<sup>2</sup> și H<sub>2</sub>O</p>" +
      "<ul><li>unu</li><li>doi</li></ul><ol><li>a</li></ol><blockquote><p>citat</p></blockquote><hr />";
    expect(html(input)).toBe(
      "<h2>Titlu</h2><p>Text <strong>aldin</strong>, <em>italic</em>, <u>subliniat</u>, <s>tăiat</s>, x<sup>2</sup> și H<sub>2</sub>O</p>" +
        "<ul><li>unu</li><li>doi</li></ul><ol><li>a</li></ol><blockquote><p>citat</p></blockquote><hr />",
    );
  });

  it("normalizează etichetele echivalente: b → strong, i → em, h1 → h2, strike/del → s, h5/h6 → h4", () => {
    expect(html("<b>x</b><i>y</i><strike>z</strike><del>w</del>")).toBe(
      "<strong>x</strong><em>y</em><s>z</s><s>w</s>",
    );
    expect(html("<h1>A</h1><h5>B</h5><h6>C</h6>")).toBe("<h2>A</h2><h4>B</h4><h4>C</h4>");
  });

  it("scoate etichetele necunoscute păstrându-le textul (font, span, center)", () => {
    expect(
      html(
        '<font face="x" color="red">a</font> <span class="s" style="c">b</span><center>c</center>',
      ),
    ).toBe("a b" + "c");
  });

  it("păstrează div-urile (fără atribute), ca structura din Woo să nu se piardă", () => {
    expect(html('<div class="x" style="y"><div>a</div><div>b</div></div>')).toBe(
      "<div><div>a</div><div>b</div></div>",
    );
  });

  it("păstrează tabelele cu antet, corp și celule, fără atribute în afară de colspan/rowspan", () => {
    const input =
      '<table style="width:100%" class="x"><thead><tr><th>Caracteristică</th><th>Valoare</th></tr></thead>' +
      '<tbody><tr><td style="a">Putere</td><td colspan="2" rowspan="3" onclick="x">5 kW</td></tr></tbody></table>';
    expect(html(input)).toBe(
      "<table><thead><tr><th>Caracteristică</th><th>Valoare</th></tr></thead>" +
        '<tbody><tr><td>Putere</td><td colspan="2" rowspan="3">5 kW</td></tr></tbody></table>',
    );
  });

  it("colspan/rowspan: doar numere întregi între 1 și 20", () => {
    for (const bad of ["0", "21", "99999999", "-1", "1.5", "2 onload=x", "abc", ""]) {
      expect(html(`<table><tr><td colspan="${bad}" rowspan="${bad}">x</td></tr></table>`)).toBe(
        "<table><tr><td>x</td></tr></table>",
      );
    }
    expect(html('<table><tr><td colspan="20" rowspan="1">x</td></tr></table>')).toBe(
      '<table><tr><td colspan="20" rowspan="1">x</td></tr></table>',
    );
  });

  it("păstrează diacriticele, simbolurile și emoji-urile", () => {
    expect(html("<p>Șurub ț ă î â € ± ° m³ 😀</p>")).toBe("<p>Șurub ț ă î â € ± ° m³ 😀</p>");
  });

  it("un text simplu cu «<» și «&» devine text escapat, nu etichetă", () => {
    expect(html("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("textul ce arată ca HTML, dar e escapat, rămâne text (nu devine etichetă)", () => {
    expect(html("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(html("&#60;script&#62;alert(1)&#60;/script&#62;")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});

describe("sanitizeRichHtml — linkuri", () => {
  it("linkul extern primește target=_blank și rel=noopener noreferrer, cele trimise de client se ignoră", () => {
    expect(
      html(
        '<a href="https://exemplu.ro/x?a=1&b=2" title="T" target="_self" rel="opener" onclick="x">t</a>',
      ),
    ).toBe(
      '<a href="https://exemplu.ro/x?a=1&amp;b=2" title="T" target="_blank" rel="noopener noreferrer">t</a>',
    );
    expect(html('<a href="http://exemplu.ro/">t</a>')).toBe(
      '<a href="http://exemplu.ro/" target="_blank" rel="noopener noreferrer">t</a>',
    );
  });

  it("linkul intern (cale care începe cu «/»), mailto și tel rămân în aceeași fereastră", () => {
    expect(html('<a href="/produse/pompe" target="_blank" rel="x">t</a>')).toBe(
      '<a href="/produse/pompe">t</a>',
    );
    expect(html('<a href="mailto:contact@exemplu.ro">m</a>')).toBe(
      '<a href="mailto:contact@exemplu.ro">m</a>',
    );
    expect(html('<a href="tel:+40712345678">t</a>')).toBe('<a href="tel:+40712345678">t</a>');
  });

  it("schemele nepermise sau ocolirile lor lasă doar textul", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "  javascript:alert(1)",
      "&#106;avascript:alert(1)",
      "vbscript:x",
      "data:text/html,x",
      "file:///etc/passwd",
      "blob:https://x/y",
      "//evil.example/x",
      "\\\\evil.example/x",
      "ftp://x/y",
      "",
      "#ancora",
      "pagina-relativa",
    ]) {
      expect(html(`<a href="${bad}">x</a>`)).toBe("x");
    }
  });

  it("un URL extern cu spații, caractere de control sau invizibile în interior nu rămâne link", () => {
    for (const bad of [
      "https://exemplu.ro/a b",
      "https://exemplu.ro/a&#9;b",
      "https://exemplu.ro/a&#127;b",
      "https://exemplu.ro/​x",
      "https://exemplu.ro/ x",
      "https://exem plu.ro/",
      "https://",
      "https:///",
      "mailto:a b@exemplu.ro",
      "tel:+40 712 345 678",
      "tel:abc",
      "mailto:",
      "mailto:a<b>@exemplu.ro",
      "mailto:a'b@exemplu.ro",
      "mailto:a\\b@exemplu.ro",
      "tel:",
      "/cale cu spații",
      "/\\evil.example",
    ]) {
      expect(html(`<a href="${bad}">x</a>`)).toBe("x");
    }
  });

  it("URL-urile lungi peste 2048 de caractere nu rămân link", () => {
    expect(html(`<a href="https://exemplu.ro/${"a".repeat(2100)}">x</a>`)).toBe("x");
  });

  it("după un link sau o imagine scoase, frații și închiderile lor rămân corecte (fără eșec închis)", () => {
    for (const removed of [
      '<a href="javascript:x">l</a>',
      '<img src="https://evil.example/x.png">',
      "<a>l</a>",
    ]) {
      const result = sanitizeRichHtml(
        `<ul><li>${removed}</li><li>b</li></ul><p>${removed}<strong>c</strong></p>`,
      );
      expect(result.stats.failedClosed, removed).toBe(false);
      expect(oracleViolations(result.html ?? ""), removed).toEqual([]);
      expect(result.html, removed).toContain("<li>b</li></ul>");
      expect(result.html, removed).toContain("<strong>c</strong></p>");
    }
  });

  it("un link fără href lasă doar textul", () => {
    expect(html('<a name="x" id="y">x</a>')).toBe("x");
  });
});

describe("sanitizeRichHtml — imagini doar din media proprie", () => {
  it("păstrează doar alt și data-media-id; src și restul atributelor dispar", () => {
    const result = sanitizeRichHtml(
      `<p><img data-media-id="${MEDIA_ID}" alt="Pompă" src="https://evil.example/x.png" onerror="alert(1)" class="c" width="900"></p>`,
    );
    expect(result.html).toBe(`<p><img alt="Pompă" data-media-id="${MEDIA_ID}" /></p>`);
    expect(result.mediaIds).toEqual([MEDIA_ID]);
    expect(result.stats.images).toBe(1);
  });

  it("alt lipsă devine alt gol (imagine decorativă)", () => {
    expect(html(`<p><img data-media-id="${MEDIA_ID}"></p>`)).toBe(
      `<p><img alt="" data-media-id="${MEDIA_ID}" /></p>`,
    );
  });

  it("o imagine cu src extern sau fără id de media se elimină și se numără", () => {
    const result = sanitizeRichHtml(
      '<p>a</p><img src="https://evil.example/x.png" alt="x"><img src="//evil.example/x.png"><img src="/api/media?id=1">',
    );
    expect(result.html).toBe("<p>a</p>");
    expect(result.stats.removedImages).toBe(3);
    expect(result.stats.images).toBe(0);
    expect(result.mediaIds).toEqual([]);
  });

  it("un id de media cu format nevalid se elimină (de sanitizator, nu de a doua plasă)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "../x",
      "a b",
      "x",
      "a".repeat(41),
      'a"onerror="x',
      "<script>",
    ]) {
      const alone = sanitizeRichHtml(`<img data-media-id="${bad}" alt="x">`);
      expect(alone.html).toBeNull();
      const withText = sanitizeRichHtml(
        `<p>text <img data-media-id="${bad}" alt="x"></p><ul><li>b</li></ul>`,
      );
      expect(withText.html).toBe("<p>text </p><ul><li>b</li></ul>");
      // eliminarea s-a făcut în pasul normal: nu a fost nevoie de eșecul închis
      expect(withText.stats.failedClosed).toBe(false);
      expect(withText.stats.removedImages).toBe(1);
      expect(withText.mediaIds).toEqual([]);
    }
  });

  it("pe fiecare etichetă permisă, atributele din afara listei albe dispar (oracol independent)", () => {
    const extra =
      'onclick="a()" onerror="b()" style="color:red" class="c" id="i" src="https://evil.example/x" srcset="y" formaction="z" tabindex="0" contenteditable="true" data-x="1" accesskey="k"';
    for (const tag of Object.keys(ORACLE_ATTRIBUTES)) {
      const attributes = [
        tag === "a" ? 'href="/x"' : "",
        tag === "img" ? `data-media-id="${MEDIA_ID}"` : "",
        extra,
      ]
        .filter(Boolean)
        .join(" ");
      const input =
        tag === "br" || tag === "hr" || tag === "img"
          ? `<${tag} ${attributes}>`
          : `<${tag} ${attributes}>x</${tag}>`;
      const result = sanitizeRichHtml(`<div>${input}</div>`);
      expect(oracleViolations(result.html ?? ""), tag).toEqual([]);
      expect(result.html ?? "", tag).not.toMatch(
        /\s(?:onclick|onerror|style|class|id|src|srcset|formaction|tabindex|contenteditable|data-x|accesskey)=/,
      );
      expect(result.stats.failedClosed, tag).toBe(false);
    }
  });

  it("cu allowedMediaIds, doar id-urile cunoscute rămân", () => {
    const other = "cm0otherid1234567890xyz";
    const result = sanitizeRichHtml(
      `<p><img data-media-id="${MEDIA_ID}" alt="a"><img data-media-id="${other}" alt="b"></p>`,
      { allowedMediaIds: new Set([MEDIA_ID]) },
    );
    expect(result.html).toBe(`<p><img alt="a" data-media-id="${MEDIA_ID}" /></p>`);
    expect(result.mediaIds).toEqual([MEDIA_ID]);
    expect(result.stats.removedImages).toBe(1);
  });

  it("mediaIds nu are dubluri", () => {
    const result = sanitizeRichHtml(
      `<img data-media-id="${MEDIA_ID}" alt="a"><img data-media-id="${MEDIA_ID}" alt="b">`,
    );
    expect(result.mediaIds).toEqual([MEDIA_ID]);
    expect(result.stats.images).toBe(2);
  });
});

describe("sanitizeRichHtml — blocuri eliminate cu tot conținutul", () => {
  it.each([
    ["script", "<script>alert(1)</script>"],
    ["style", "<style>p{color:red}</style>"],
    ["iframe", "<iframe src='https://x'>text de rezervă</iframe>"],
    ["object", "<object data='x'>text</object>"],
    ["embed", "<embed src='x'>"],
    ["svg", "<svg><text>text</text><a href='https://x'>l</a></svg>"],
    ["math", "<math><mi>x</mi></math>"],
    ["form", "<form><p>câmp</p><input name='x'></form>"],
    ["button", "<button>apasă</button>"],
    ["textarea", "<textarea>text</textarea>"],
    ["select", "<select><option>o</option></select>"],
    ["noscript", "<noscript>text</noscript>"],
    ["template", "<template><p>text</p></template>"],
    ["video", "<video controls poster='x'><source src='y'>text</video>"],
    ["audio", "<audio src='x'>text</audio>"],
    ["canvas", "<canvas>text</canvas>"],
  ])("%s dispare cu tot cu conținut", (_name, block) => {
    const result = sanitizeRichHtml(`<p>înainte</p>${block}<p>după</p>`);
    expect(result.html).toBe("<p>înainte</p><p>după</p>");
    expect(result.stats.removedBlocks).toBeGreaterThanOrEqual(1);
  });

  it("un bloc neînchis taie restul textului", () => {
    expect(html("<p>a</p><style>p{color:red}<p>b</p>")).toBe("<p>a</p>");
    expect(html("<p>a</p><script>alert(1)<p>b</p>")).toBe("<p>a</p>");
  });

  it("caracterele de control din intrare (NUL etc.) nu pot ascunde o etichetă periculoasă", () => {
    expect(html("<scr\u0000ipt>alert(1)</scr\u0000ipt><p>a</p>")).toBe("<p>a</p>");
    expect(html("<p>a</p><i\u0001frame src=x>b</i\u0001frame>")).toBe("<p>a</p>");
    expect(html("<p>a\u0000b\u0008c\u007fd\u0085e</p>")).toBe("<p>abcde</p>");
  });

  it("comentariile (și cele neînchise, și blocurile WordPress) dispar", () => {
    expect(html("<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph -->")).toBe("<p>a</p>");
    expect(html("<p>a</p><!-- neînchis <img src=x onerror=alert(1)>")).toBe("<p>a</p>");
  });
});

describe("sanitizeRichHtml — descriere goală", () => {
  it.each([
    ["șir gol", ""],
    ["doar spații", "     "],
    ["tab și linii noi", "\t\n \r\n"],
    ["paragraf gol", "<p></p>"],
    ["paragraf cu spațiu", "<p> </p>"],
    ["paragraf cu nbsp", "<p>&nbsp;</p>"],
    ["paragraf cu br (starea goală a editorului)", "<p><br></p>"],
    ["mai multe paragrafe goale", "<p></p><p> </p><p><br /></p>"],
    ["div gol", "<div></div>"],
    ["doar spații de lățime zero", "<p>​​﻿⁠</p>"],
    ["doar un comentariu", "<!-- nimic -->"],
    ["doar un script", "<script>alert(1)</script>"],
    ["tabel fără text", "<table><tr><td></td><td>&nbsp;</td></tr></table>"],
    ["listă goală", "<ul><li></li></ul>"],
    ["doar o imagine eliminată", '<p><img src="https://evil.example/x.png"></p>'],
  ])("%s → null (niciodată un șir gol)", (_name, input) => {
    const result = sanitizeRichHtml(input);
    expect(result.html).toBeNull();
    expect(result.mediaIds).toEqual([]);
  });

  it("o imagine validă, singură, NU e descriere goală", () => {
    expect(html(`<p><img data-media-id="${MEDIA_ID}" alt=""></p>`)).toBe(
      `<p><img alt="" data-media-id="${MEDIA_ID}" /></p>`,
    );
  });

  it("paragrafele goale de la capete se scot, cele din mijloc rămân", () => {
    expect(html("<p></p><p><br></p><p>a</p><p></p><p>b</p><p> </p>")).toBe(
      "<p>a</p><p></p><p>b</p>",
    );
  });

  it("spațiile de la capete se taie", () => {
    expect(html("   <p>a</p>\n\n  ")).toBe("<p>a</p>");
  });
});

describe("sanitizeRichHtml — limite", () => {
  it("refuză o intrare peste limită, cu ValidationError și motiv", () => {
    const input = "a".repeat(RICH_TEXT_LIMITS.maxInputLength + 1);
    expect(() => sanitizeRichHtml(input)).toThrow(ValidationError);
    try {
      sanitizeRichHtml(input);
    } catch (error) {
      expect((error as ValidationError).details).toMatchObject({ reason: "input_too_long" });
    }
  });

  it("refuză o ieșire peste limită (nu o taie: HTML tăiat ar fi stricat)", () => {
    const input = `<p>${"a".repeat(RICH_TEXT_LIMITS.maxOutputLength)}</p>`;
    expect(() => sanitizeRichHtml(input)).toThrow(ValidationError);
    try {
      sanitizeRichHtml(input);
    } catch (error) {
      expect((error as ValidationError).details).toMatchObject({ reason: "output_too_long" });
    }
  });

  it("acceptă exact limita de ieșire", () => {
    const text = "a".repeat(RICH_TEXT_LIMITS.maxOutputLength - "<p></p>".length);
    expect(html(`<p>${text}</p>`)?.length).toBe(RICH_TEXT_LIMITS.maxOutputLength);
  });

  it("refuză prea multe imagini", () => {
    const image = `<img data-media-id="${MEDIA_ID}" alt="">`;
    expect(() => sanitizeRichHtml(image.repeat(RICH_TEXT_LIMITS.maxImages + 1))).toThrow(
      ValidationError,
    );
    expect(sanitizeRichHtml(image.repeat(RICH_TEXT_LIMITS.maxImages)).stats.images).toBe(
      RICH_TEXT_LIMITS.maxImages,
    );
  });

  it("refuză prea multe celule de tabel", () => {
    const row = `<tr>${"<td>x</td>".repeat(100)}</tr>`;
    const rows = Math.floor(RICH_TEXT_LIMITS.maxTableCells / 100);
    expect(() => sanitizeRichHtml(`<table>${row.repeat(rows + 1)}</table>`)).toThrow(
      ValidationError,
    );
    expect(sanitizeRichHtml(`<table>${row.repeat(rows)}</table>`).html).not.toBeNull();
  });

  it("imbricarea adâncă se aplatizează la limită, cu textul păstrat și rapid", () => {
    const depth = 10_000;
    const input = `${"<div>".repeat(depth)}text${"</div>".repeat(depth)}`;
    const started = performance.now();
    const output = html(input) ?? "";
    expect(performance.now() - started).toBeLessThan(3000);
    expect(output).toContain("text");
    let level = 0;
    let max = 0;
    for (const match of output.matchAll(/<(\/?)div>/g)) {
      level += match[1] === "/" ? -1 : 1;
      max = Math.max(max, level);
    }
    expect(max).toBeLessThanOrEqual(RICH_TEXT_LIMITS.maxNesting);
    expect(oracleViolations(output)).toEqual([]);
  });

  it("intrări ostile mari se procesează în timp rezonabil (fără backtracking)", () => {
    const hostile = [
      "<a ".repeat(30_000),
      "<!--".repeat(30_000),
      "<svg>".repeat(10_000),
      "<p><b><i>".repeat(10_000),
      "&".repeat(100_000),
      `<a href="${"j".repeat(100_000)}">x</a>`,
      "<table>".repeat(5_000),
    ];
    for (const input of hostile) {
      const started = performance.now();
      try {
        sanitizeRichHtml(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
      }
      expect(performance.now() - started).toBeLessThan(3000);
    }
  });
});

describe("sanitizeRichHtml — statistici și schimbare", () => {
  it("numără tabelele, linkurile valide, imaginile și blocurile eliminate", () => {
    const result = sanitizeRichHtml(
      '<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table><a href="https://x.ro/">l</a><a href="javascript:x">m</a><script>x</script><style>y</style>',
    );
    expect(result.stats.tables).toBe(2);
    expect(result.stats.links).toBe(1);
    expect(result.stats.removedBlocks).toBe(2);
  });

  it("changed e fals pentru HTML deja curat și adevărat când ceva s-a schimbat", () => {
    expect(sanitizeRichHtml("<p>a <strong>b</strong></p>").changed).toBe(false);
    expect(sanitizeRichHtml('<p onclick="x">a</p>').changed).toBe(true);
    expect(sanitizeRichHtml("<p> </p>").changed).toBe(true);
    expect(sanitizeRichHtml("").changed).toBe(false);
  });

  it("failedClosed e fals în mod normal", () => {
    expect(sanitizeRichHtml("<p>a</p>").stats.failedClosed).toBe(false);
  });
});

describe("sanitizeRichHtml — vectori XSS clasici", () => {
  for (const [name, vector] of Object.entries(XSS_VECTORS)) {
    it(`${name}: ieșirea e curată (oracol independent) și stabilă la a doua trecere`, () => {
      let first: string | null;
      try {
        first = html(vector);
      } catch (error) {
        // refuzul explicit (limite) e acceptabil; o excepție de alt fel nu
        expect(error).toBeInstanceOf(ValidationError);
        return;
      }
      expect(oracleViolations(first ?? "")).toEqual([]);
      if (first !== null) expect(html(first)).toBe(first);
      // sanitizatorul însuși produce ieșire conformă; eșecul închis e doar plasa de siguranță
      expect(sanitizeRichHtml(vector).stats.failedClosed).toBe(false);
    });
  }

  it("nicio ieșire nu conține marcaje active în clar", () => {
    for (const [name, vector] of Object.entries(XSS_VECTORS)) {
      let output: string | null;
      try {
        output = html(vector);
      } catch {
        continue;
      }
      expect(output ?? "", name).not.toMatch(
        /<\s*(?:script|iframe|object|embed|svg|math|style|link|meta|base|form|input)/i,
      );
      expect(output ?? "", name).not.toMatch(/\son[a-z]+\s*=/i);
      expect(output ?? "", name).not.toMatch(/href="\s*(?:javascript|vbscript|data):/i);
    }
  });

  it("rezultate exacte pentru vectorii cei mai frecvenți", () => {
    expect(html("<script>alert(1)</script>")).toBeNull();
    expect(html("<img src=x onerror=alert(1)>")).toBeNull();
    expect(html('<a href="javascript:alert(1)">x</a>')).toBe("x");
    expect(html('<p style="background:url(javascript:alert(1))">a</p>')).toBe("<p>a</p>");
    expect(html('<iframe srcdoc="<script>alert(1)</script>"></iframe><p>ok</p>')).toBe("<p>ok</p>");
    expect(html('<svg onload="alert(1)"><text>x</text></svg><p>ok</p>')).toBe("<p>ok</p>");
    expect(html('<p onmouseover="alert(1)">ok</p>')).toBe("<p>ok</p>");
  });
});

describe("sanitizeRichHtml — fuzzing determinist", () => {
  // generator cu sămânță fixă (mulberry32), fără Math.random: testul e reproductibil
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("din fragmente amestecate (valide, ostile, rupte), ieșirea trece oracolul și e stabilă", () => {
    const fragments = [
      ...Object.values(XSS_VECTORS),
      "<p>",
      "</p>",
      "<div>",
      "</div>",
      "<table>",
      "<tr><td>",
      "</td></tr></table>",
      "<a href=",
      '"https://exemplu.ro/"',
      ">",
      "<",
      "&",
      "&amp;",
      "&#",
      "text",
      " ",
      "\n",
      "<!--",
      "-->",
      "<![CDATA[",
      "]]>",
      '"',
      "'",
      "=",
      "/",
    ];
    const random = seeded(20261105);
    for (let round = 0; round < 400; round++) {
      const parts: string[] = [];
      const count = 1 + Math.floor(random() * 12);
      for (let i = 0; i < count; i++)
        parts.push(fragments[Math.floor(random() * fragments.length)] as string);
      const input = parts.join("");
      let first: string | null;
      try {
        first = html(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        continue;
      }
      expect(oracleViolations(first ?? ""), input).toEqual([]);
      if (first !== null) expect(html(first), input).toBe(first);
      expect(sanitizeRichHtml(input).stats.failedClosed, input).toBe(false);
    }
  });
});
