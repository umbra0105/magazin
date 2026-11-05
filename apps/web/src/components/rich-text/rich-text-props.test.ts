import { describe, expect, it } from "vitest";
import { richTextProps } from "./rich-text-props";

describe("richTextProps", () => {
  it("clasa de stil a descrierii și HTML-ul primit, neschimbat", () => {
    expect(richTextProps("<p>Salut</p>")).toEqual({ className: "rich-text", html: "<p>Salut</p>" });
  });

  it("clasa primită se adaugă după cea a descrierii", () => {
    expect(richTextProps("<p>x</p>", "mt-4")).toEqual({
      className: "rich-text mt-4",
      html: "<p>x</p>",
    });
  });

  it("o clasă goală sau lipsă nu lasă spații în plus", () => {
    expect(richTextProps("<p>x</p>", "")?.className).toBe("rich-text");
    expect(richTextProps("<p>x</p>", undefined)?.className).toBe("rich-text");
  });

  it("fără conținut nu desenează nimic (nici un container gol)", () => {
    for (const empty of ["", null, undefined]) expect(richTextProps(empty, "mt-4")).toBeNull();
  });
});
