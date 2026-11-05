import { ValidationError } from "@ecom/shared";
import type { PrismaClient } from "@ecom/db";
import { describe, expect, it, vi } from "vitest";
import { looksLikeHtml, prepareDescription, sanitizeDescription } from "./description";
import { RICH_TEXT_LIMITS } from "./rules";

const ID_A = "cm0imaginea1234567890xy";
const ID_B = "cm0imagineb1234567890xy";

describe("looksLikeHtml", () => {
  it.each([
    "<p>x</p>",
    "text <b>aldin</b>",
    "<br>",
    "</div>",
    "<!-- comentariu -->",
    '<a href="https://exemplu.ro">l</a>',
    "<img src=x onerror=alert(1)>",
  ])("%s → HTML", (text) => {
    expect(looksLikeHtml(text)).toBe(true);
  });

  it.each([
    "text simplu",
    "a < b",
    "a < b și c > d",
    "5<6",
    "a <3 b",
    "x<y",
    "a > b",
    "prețul e < 100 lei & > 50 lei",
    "",
  ])("%s → text simplu", (text) => {
    expect(looksLikeHtml(text)).toBe(false);
  });
});

describe("sanitizeDescription", () => {
  it("null, nedefinit, gol și doar spații → null", () => {
    for (const empty of [
      null,
      undefined,
      "",
      "  ",
      "\n\t\n",
      "<p></p>",
      "<p>&nbsp;</p>",
      "<p><br></p>",
    ]) {
      expect(sanitizeDescription(empty).html, JSON.stringify(empty)).toBeNull();
    }
  });

  it("textul simplu (textarea veche) devine paragrafe, cu escape", () => {
    expect(sanitizeDescription("Linia 1\nLinia 2\n\nParagraf nou").html).toBe(
      "<p>Linia 1<br />Linia 2</p><p>Paragraf nou</p>",
    );
    expect(sanitizeDescription("a < b & c > d").html).toBe("<p>a &lt; b &amp; c &gt; d</p>");
    expect(sanitizeDescription("5<6 și x<y").html).toBe("<p>5&lt;6 și x&lt;y</p>");
  });

  it("HTML-ul se sanitizează (nu se tratează ca text)", () => {
    expect(sanitizeDescription('<p onclick="x">a</p><script>alert(1)</script>').html).toBe(
      "<p>a</p>",
    );
    expect(sanitizeDescription("<b>x</b>").html).toBe("<strong>x</strong>");
  });

  it("textul simplu foarte lung e refuzat (ValidationError), nu tăiat", () => {
    expect(() => sanitizeDescription("a".repeat(RICH_TEXT_LIMITS.maxInputLength + 1))).toThrow(
      ValidationError,
    );
    expect(() => sanitizeDescription("a".repeat(RICH_TEXT_LIMITS.maxOutputLength))).toThrow(
      ValidationError,
    );
  });

  it("păstrează statisticile și id-urile de media ale sanitizatorului", () => {
    const result = sanitizeDescription(`<p><img data-media-id="${ID_A}" alt="x"></p>`);
    expect(result.mediaIds).toEqual([ID_A]);
    expect(result.stats.images).toBe(1);
  });
});

function fakeDb(existing: readonly string[]): {
  db: Pick<PrismaClient, "media">;
  findMany: ReturnType<typeof vi.fn>;
} {
  const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.filter((id) => existing.includes(id)).map((id) => ({ id })),
  );
  return { db: { media: { findMany } } as unknown as Pick<PrismaClient, "media">, findMany };
}

describe("prepareDescription (verifică în bază fișierele media din descriere)", () => {
  it("păstrează doar imaginile al căror fișier există, restul se elimină și se numără", async () => {
    const { db } = fakeDb([ID_A]);
    const result = await prepareDescription(
      db,
      `<p>t</p><img data-media-id="${ID_A}" alt="a"><img data-media-id="${ID_B}" alt="b">`,
    );
    expect(result.html).toBe(`<p>t</p><img alt="a" data-media-id="${ID_A}" />`);
    expect(result.mediaIds).toEqual([ID_A]);
    expect(result.result.stats.removedImages).toBe(1);
  });

  it("întreabă baza doar pentru imagini de tip image/* care nu au eșuat", async () => {
    const { db, findMany } = fakeDb([ID_A]);
    await prepareDescription(db, `<img data-media-id="${ID_A}" alt="a">`);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: { in: [ID_A] }, mime: { startsWith: "image/" }, status: { not: "failed" } },
    });
  });

  it("fără imagini nu interoghează baza", async () => {
    const { db, findMany } = fakeDb([]);
    const result = await prepareDescription(db, "<p>fără imagini</p>");
    expect(findMany).not.toHaveBeenCalled();
    expect(result.html).toBe("<p>fără imagini</p>");
    expect(result.mediaIds).toEqual([]);
  });

  it("null / gol → null, fără interogare", async () => {
    const { db, findMany } = fakeDb([]);
    expect((await prepareDescription(db, null)).html).toBeNull();
    expect((await prepareDescription(db, "<p></p>")).html).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("dacă nicio imagine nu există, descrierea rămâne cu textul ei", async () => {
    const { db } = fakeDb([]);
    const result = await prepareDescription(db, `<p>text</p><img data-media-id="${ID_A}" alt="a">`);
    expect(result.html).toBe("<p>text</p>");
    expect(result.mediaIds).toEqual([]);
  });

  it("o descriere doar cu o imagine inexistentă devine null", async () => {
    const { db } = fakeDb([]);
    expect((await prepareDescription(db, `<img data-media-id="${ID_A}" alt="a">`)).html).toBeNull();
  });
});
