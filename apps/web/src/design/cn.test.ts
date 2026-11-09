import { describe, expect, it } from "vitest";
import { TEXT_SIZE_TOKENS, cn } from "@ecom/ui";

/**
 * `cn` îmbină clase Tailwind (ultima câștigă) și trebuie să cunoască tokenii proprii ai design-ului: o mărime de text
 * (`text-label`) nu e o culoare, deci nu se elimină când urmează o culoare (`text-ink-secondary`), iar două mărimi se înlocuiesc.
 */
describe("cn cu scara tipografică a design-ului", () => {
  it("mărimea și culoarea textului coexistă, în orice ordine", () => {
    expect(cn("text-label text-ink-secondary")).toBe("text-label text-ink-secondary");
    expect(cn("text-ink-secondary text-label")).toBe("text-ink-secondary text-label");
    expect(cn("text-body text-tone-problem-fg")).toBe("text-body text-tone-problem-fg");
  });

  it("fiecare token al scării se păstrează lângă o culoare", () => {
    for (const size of TEXT_SIZE_TOKENS) {
      expect(cn(`text-${size}`, "text-ink")).toBe(`text-${size} text-ink`);
    }
  });

  it("două mărimi de text se înlocuiesc (ultima câștigă), inclusiv față de scara Tailwind și de variabile", () => {
    expect(cn("text-body", "text-label")).toBe("text-label");
    expect(cn("text-section", "text-lg")).toBe("text-lg");
    expect(cn("text-lg", "text-section")).toBe("text-section");
    expect(cn("text-(length:--control-text)", "text-label")).toBe("text-label");
  });

  it("două culori de text se înlocuiesc (ultima câștigă)", () => {
    expect(cn("text-ink", "text-ink-secondary")).toBe("text-ink-secondary");
  });

  it("înălțimile din variabile se înlocuiesc între ele și cu scara Tailwind", () => {
    expect(cn("h-(--control-h)", "h-9")).toBe("h-9");
    expect(cn("h-9", "h-(--control-h)")).toBe("h-(--control-h)");
  });

  it("lățimea maximă a apelantului o înlocuiește pe cea implicită", () => {
    expect(cn("max-w-2xl", "max-w-md")).toBe("max-w-md");
  });
});
