import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "./html-to-text";

const text = (html: string): string => htmlToPlainText(html).text;

describe("htmlToPlainText", () => {
  it("paragrafele, br și titlurile devin paragrafe și linii", () => {
    expect(
      text("<h2>Titlu secțiune</h2><p>Primul paragraf.</p><p>Al doilea<br>pe două linii.</p>"),
    ).toBe("Titlu secțiune\n\nPrimul paragraf.\n\nAl doilea\npe două linii.");
    expect(text("<div>a</div><div>b</div>")).toBe("a\nb");
  });

  it("listele devin linii cu «- »", () => {
    expect(text("<ul><li>Primul</li><li>Al doilea <strong>bold</strong></li></ul>")).toBe(
      "- Primul\n- Al doilea bold",
    );
    expect(text("<p>Include:</p><ol><li>unu</li><li>doi</li></ol>")).toBe(
      "Include:\n\n- unu\n- doi",
    );
  });

  it("tabelele: două celule → «Etichetă: valoare»; mai multe → separate prin «|»; o celulă → text", () => {
    const html =
      "<table><tbody>" +
      "<tr><td>Putere</td><td>0,75 kW</td></tr>" +
      "<tr><td>Debit</td><td>12&nbsp;m³/h</td></tr>" +
      "<tr><td colspan=2>Notă la tabel</td></tr>" +
      "<tr><th>Model</th><th>Putere</th><th>Debit</th></tr>" +
      "<tr><td>A</td><td>1</td><td>2</td></tr>" +
      "</tbody></table>";
    const result = htmlToPlainText(html);
    expect(result.text).toBe(
      "Putere: 0,75 kW\nDebit: 12 m³/h\nNotă la tabel\nModel | Putere | Debit\nA | 1 | 2",
    );
    expect(result.stats.tables).toBe(1);
  });

  it("celulele cu etichete și linii noi se strâng pe o linie", () => {
    expect(text("<table><tr><td><strong>Greutate</strong></td><td>5<br>kg</td></tr></table>")).toBe(
      "Greutate: 5 kg",
    );
  });

  it("linkurile păstrează doar textul; imaginile, video, iframe se elimină; se numără", () => {
    const result = htmlToPlainText(
      '<p>Vezi <a href="https://exemplu.invalid/x" target="_blank">fișa tehnică</a> și <img src="a.jpg" alt="poză"> ' +
        '<video controls><source src="v.mp4"></video><iframe src="https://exemplu.invalid/y"></iframe> final.</p>',
    );
    expect(result.text).toBe("Vezi fișa tehnică și final.");
    expect(result.stats).toMatchObject({ links: 1, images: 1, removedBlocks: 2 });
    expect(result.text).not.toContain("exemplu.invalid");
  });

  it("blocurile style și script se elimină cu tot conținutul, inclusiv cele nepereche", () => {
    expect(text("<style>.a{color:red}</style><p>Text</p><script>alert(1)</script>")).toBe("Text");
    expect(text("<p>Înainte</p><script>alert('x')")).toBe("Înainte");
    expect(text("<STYLE type='text/css'>p{}</STYLE>Gata")).toBe("Gata");
    const hostile = htmlToPlainText(
      '<p>ok</p><SCRIPT SRC="https://exemplu.invalid/x.js"></SCRIPT><p onclick="x()">bine</p>',
    );
    expect(hostile.text).toBe("ok\n\nbine");
  });

  it("comentariile (inclusiv blocurile WordPress) dispar", () => {
    expect(text("<!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph -->")).toBe("Text");
    expect(text("Text <!-- neînchis și ascuns")).toBe("Text");
  });

  it("shortcode-urile WordPress se scot, textul dintre ele rămâne; paranteze obișnuite nu", () => {
    const result = htmlToPlainText(
      '[caption id="attachment_1" align="alignnone"]Pompa instalată[/caption] [gallery ids="1,2,3"] ' +
        "[vc_row][vc_column]Conținut[/vc_column][/vc_row] Distanță [min 5 m] și [NOU] [1]",
    );
    expect(result.text).toBe("Pompa instalată Conținut Distanță [min 5 m] și [NOU] [1]");
    expect(result.stats.shortcodes).toBe(7);
  });

  it("entitățile se decodează (numite, zecimale, hexazecimale); nbsp devine spațiu", () => {
    expect(
      text("Ioan &amp; Maria&nbsp;&mdash; &#537;i &#x21B;ar&#259; &lt;3 &euro;5 &necunoscut;"),
    ).toBe("Ioan & Maria — și țară <3 €5 &necunoscut;");
  });

  it("un &lt;script&gt; decodat nu lasă etichete în rezultat", () => {
    const result = htmlToPlainText(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; text &lt;b&gt;bold&lt;/b&gt;</p>",
    );
    expect(result.text).not.toMatch(/<\/?[a-z]/i);
    expect(result.text).toContain("text");
  });

  it("spațiile se normalizează și liniile goale multiple se strâng", () => {
    expect(text("  <p>  a   b\t c </p>\n\n\n\n<p>d</p>  ")).toBe("a b c\n\nd");
    expect(text(`a${String.fromCharCode(0xa0, 0xa0)}b${String.fromCharCode(0x200b)}c`)).toBe(
      "a bc",
    );
  });

  it("text simplu rămâne neschimbat (changed = false); HTML-ul îl marchează schimbat", () => {
    expect(htmlToPlainText("Pompă silențioasă.").changed).toBe(false);
    expect(htmlToPlainText("<p>Pompă</p>").changed).toBe(true);
    expect(htmlToPlainText("Ioan &amp; Maria").changed).toBe(true);
  });

  it("limita de lungime: tăiat cu «…» și marcat", () => {
    const result = htmlToPlainText(`<p>${"a".repeat(50)}</p>`, 20);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(20);
    expect(result.text.endsWith("…")).toBe(true);
  });

  it("intrări ostile: etichete deformate nu blochează și nu lasă etichete", () => {
    const messy =
      '<p><a href="x"<b>text</b><img src=x onerror=alert(1)><table><tr><td>a<td>b</table>';
    const result = htmlToPlainText(messy);
    expect(result.text).not.toMatch(/<\/?[a-z]/i);
    expect(result.text).toContain("text");
    expect(result.text).toContain("a: b");
    // fără blocaj pe intrări lungi și deformate
    const started = Date.now();
    htmlToPlainText("<div".repeat(20_000) + "<table>".repeat(2_000));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
