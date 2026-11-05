import { describe, expect, it, vi } from "vitest";
import { oracleViolations } from "./oracle";
import { renderRichText, type MediaResolver, type RenderedMedia } from "./render";

const ID_A = "cm0imaginea1234567890xy";
const ID_B = "cm0imagineb1234567890xy";

const media = (over: Partial<RenderedMedia> = {}): RenderedMedia => ({
  src: "/media/a-800.webp",
  srcset: "/media/a-320.webp 320w, /media/a-800.webp 800w",
  width: 1600,
  height: 1200,
  ...over,
});

const resolverOf =
  (table: Record<string, RenderedMedia>): MediaResolver =>
  async (ids) =>
    new Map(ids.filter((id) => table[id]).map((id) => [id, table[id] as RenderedMedia]));

const none: MediaResolver = async () => new Map();

const OPTIONS = { tableLabel: "Tabel derulabil", imageSizes: "(min-width: 48rem) 48rem, 100vw" };

describe("renderRichText: gol și valori ostile", () => {
  it.each([null, undefined, "", "   ", "<p></p>", "<p>&nbsp;</p>"])(
    "%j → șir gol",
    async (empty) => {
      expect(await renderRichText(empty, none, OPTIONS)).toBe("");
    },
  );

  it("re-sanitizează o valoare ostilă rămasă în bază (nu are încredere în ce citește)", async () => {
    const html = await renderRichText(
      '<p onclick="alert(1)">a</p><script>alert(1)</script><a href="javascript:alert(1)">l</a><iframe src="https://evil.example"></iframe>',
      none,
      OPTIONS,
    );
    expect(html).toBe("<p>a</p>l");
  });

  it("o descriere peste limită (imposibilă prin serviciu) nu strică pagina: șir gol", async () => {
    expect(await renderRichText(`<p>${"a".repeat(600_000)}</p>`, none, OPTIONS)).toBe("");
  });

  it("textul simplu rămas în bază (fără etichete) se afișează ca paragrafe, escapat", async () => {
    expect(await renderRichText("a < b & c", none, OPTIONS)).toBe("<p>a &lt; b &amp; c</p>");
  });
});

describe("renderRichText: imagini din media", () => {
  it("înlocuiește data-media-id cu src, srcset, sizes, dimensiuni, lazy și decoding async", async () => {
    const html = await renderRichText(
      `<p>t</p><img data-media-id="${ID_A}" alt="Pompă &amp; filtru">`,
      resolverOf({ [ID_A]: media() }),
      OPTIONS,
    );
    expect(html).toBe(
      '<p>t</p><img src="/media/a-800.webp" srcset="/media/a-320.webp 320w, /media/a-800.webp 800w" sizes="(min-width: 48rem) 48rem, 100vw" width="1600" height="1200" alt="Pompă &amp; filtru" loading="lazy" decoding="async" />',
    );
  });

  it("fără srcset sau dimensiuni, acele atribute lipsesc", async () => {
    const html = await renderRichText(
      `<img data-media-id="${ID_A}" alt="">`,
      resolverOf({ [ID_A]: media({ srcset: null, width: null, height: null }) }),
      OPTIONS,
    );
    expect(html).toBe('<img src="/media/a-800.webp" alt="" loading="lazy" decoding="async" />');
  });

  it("o imagine pe care resolverul nu o mai găsește (fișier șters) dispare, restul rămâne", async () => {
    const html = await renderRichText(
      `<p>a</p><img data-media-id="${ID_A}" alt=""><img data-media-id="${ID_B}" alt="b"><p>z</p>`,
      resolverOf({ [ID_B]: media({ src: "/media/b.webp", srcset: null }) }),
      OPTIONS,
    );
    expect(html).toBe(
      '<p>a</p><img src="/media/b.webp" width="1600" height="1200" alt="b" loading="lazy" decoding="async" /><p>z</p>',
    );
  });

  it("întreabă resolverul o singură dată, cu id-urile fără dubluri", async () => {
    const resolver = vi.fn(resolverOf({ [ID_A]: media() }));
    await renderRichText(
      `<img data-media-id="${ID_A}" alt=""><img data-media-id="${ID_A}" alt="">`,
      resolver,
      OPTIONS,
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]?.[0]).toEqual([ID_A]);
  });

  it("fără imagini nu interoghează resolverul", async () => {
    const resolver = vi.fn(none);
    await renderRichText("<p>fără imagini</p>", resolver, OPTIONS);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("valorile din resolver se escapează în atribute (nu pot ieși din ghilimele)", async () => {
    const html = await renderRichText(
      `<img data-media-id="${ID_A}" alt="">`,
      resolverOf({
        [ID_A]: media({
          src: '/media/x.webp"onerror="alert(1)',
          srcset: '/m/a.webp 1w" onload="alert(2)',
        }),
      }),
      OPTIONS,
    );
    // un singur element, cu exact atributele așteptate: valorile ostile au rămas în interiorul ghilimelelor
    expect(html).toMatch(
      /^<img src="[^"<>]*" srcset="[^"<>]*" sizes="[^"<>]*" width="\d+" height="\d+" alt="" loading="lazy" decoding="async" \/>$/,
    );
    expect(html).toContain("&quot;");
  });

  it("un src care nu e cale locală sau http(s) (javascript:, data:) nu se afișează: imaginea dispare", async () => {
    for (const src of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "//evil.example/x.png",
      "",
    ]) {
      const html = await renderRichText(
        `<p>t</p><img data-media-id="${ID_A}" alt="">`,
        resolverOf({ [ID_A]: media({ src }) }),
        OPTIONS,
      );
      expect(html, src).toBe("<p>t</p>");
    }
  });
});

describe("renderRichText: tabele și linkuri", () => {
  it("fiecare tabel e într-o regiune derulabilă accesibilă (tabindex, rol, etichetă)", async () => {
    const html = await renderRichText(
      "<table><tr><td>Putere</td><td>5 kW</td></tr></table><p>între</p><table><tr><td>b</td></tr></table>",
      none,
      OPTIONS,
    );
    const open =
      '<div class="rich-text__scroll" role="region" tabindex="0" aria-label="Tabel derulabil">';
    expect(html).toBe(
      `${open}<table><tr><td>Putere</td><td>5 kW</td></tr></table></div><p>între</p>${open}<table><tr><td>b</td></tr></table></div>`,
    );
  });

  it("eticheta regiunii vine din parametru și se escapează", async () => {
    const html = await renderRichText("<table><tr><td>x</td></tr></table>", none, {
      ...OPTIONS,
      tableLabel: 'Tabel "mare"',
    });
    expect(html).toContain('aria-label="Tabel &quot;mare&quot;"');
  });

  it("linkurile păstrează target și rel de la sanitizator; cele periculoase au dispărut", async () => {
    const html = await renderRichText(
      '<a href="https://exemplu.ro/x">ext</a> <a href="/p">int</a> <a href="javascript:x">rău</a>',
      none,
      OPTIONS,
    );
    expect(html).toBe(
      '<a href="https://exemplu.ro/x" target="_blank" rel="noopener noreferrer">ext</a> <a href="/p">int</a> rău',
    );
  });
});

describe("renderRichText: ieșirea e verificată (oracol independent pe ce nu e adăugat de randare)", () => {
  it("după scoaterea imaginilor și a regiunilor derulabile, rămâne doar HTML din lista albă", async () => {
    const html = await renderRichText(
      `<h2>T</h2><p onclick="x">a <b>b</b></p><table><tr><td>c</td></tr></table><img data-media-id="${ID_A}" alt="x"><ul><li>l</li></ul>`,
      resolverOf({ [ID_A]: media() }),
      OPTIONS,
    );
    const bare = html
      .replace(/<img [^>]*\/>/g, "")
      .replace(/<div class="rich-text__scroll"[^>]*>/g, "<div>");
    expect(oracleViolations(bare)).toEqual([]);
  });
});

describe("renderRichText: memorie pentru sanitizare", () => {
  it("aceeași valoare randată de două ori se sanitizează o singură dată", async () => {
    vi.resetModules();
    const sanitize = vi.fn((value: string | null) => ({
      html: value,
      mediaIds: [] as string[],
      stats: {
        tables: 0,
        links: 0,
        images: 0,
        removedImages: 0,
        removedBlocks: 0,
        failedClosed: false,
      },
      changed: false,
    }));
    vi.doMock("./description", () => ({ sanitizeDescription: sanitize }));
    const { renderRichText: fresh } = await import("./render");
    const value = "<p>memorată</p>";
    await fresh(value, none, OPTIONS);
    await fresh(value, none, OPTIONS);
    await fresh("<p>alta</p>", none, OPTIONS);
    expect(sanitize).toHaveBeenCalledTimes(2);
    vi.doUnmock("./description");
  });
});

describe("renderRichText: plasa finală și memoria mărginită", () => {
  const stats = {
    tables: 0,
    links: 0,
    images: 0,
    removedImages: 0,
    removedBlocks: 0,
    failedClosed: false,
  };
  const fake = (html: string | null) => ({ html, mediaIds: [] as string[], stats, changed: false });

  it("dacă sanitizarea ar lăsa ceva în afara listei albe, se afișează doar textul (nu HTML-ul)", async () => {
    vi.resetModules();
    vi.doMock("./description", () => ({
      sanitizeDescription: () => fake('<p onclick="alert(1)">text</p><script>alert(2)</script>'),
    }));
    const { renderRichText: fresh } = await import("./render");
    expect(await fresh("orice", none, OPTIONS)).toBe("<p>text</p>");
    vi.doUnmock("./description");
  });

  it("memoria păstrează cel mult 128 de valori: cea mai veche iese, cele recente rămân", async () => {
    vi.resetModules();
    const sanitize = vi.fn((value: string | null) => fake(value));
    vi.doMock("./description", () => ({ sanitizeDescription: sanitize }));
    const { renderRichText: fresh } = await import("./render");
    for (let i = 0; i < 130; i++) await fresh(`<p>${i}</p>`, none, OPTIONS);
    expect(sanitize).toHaveBeenCalledTimes(130);
    await fresh("<p>129</p>", none, OPTIONS);
    expect(sanitize).toHaveBeenCalledTimes(130);
    await fresh("<p>0</p>", none, OPTIONS);
    expect(sanitize).toHaveBeenCalledTimes(131);
    vi.doUnmock("./description");
  });
});
