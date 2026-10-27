import { describe, expect, it } from "vitest";
import { ValidationError } from "@ecom/shared";
import { normalizeAlertEmail } from "./back-in-stock";

/**
 * Adresa dintr-o cerere «Anunță-mă când revine»: tăiată și cu litere mici (indexul unic și plafoanele compară
 * `lower(email)`), validă ca formă și de cel mult 254 de caractere (CHECK-ul din bază). Orice altceva e `ValidationError`.
 */
describe("normalizeAlertEmail", () => {
  it("taie spațiile și trece în litere mici", () => {
    expect(normalizeAlertEmail("  Client.Test@Exemplu.RO ")).toBe("client.test@exemplu.ro");
  });

  it("acceptă o adresă obișnuită, cu + și subdomeniu", () => {
    expect(normalizeAlertEmail("ana+piscine@mail.exemplu.ro")).toBe("ana+piscine@mail.exemplu.ro");
  });

  it.each([
    ["gol", ""],
    ["doar spații", "   "],
    ["fără @", "client.exemplu.ro"],
    ["fără domeniu", "client@"],
    ["fără parte locală", "@exemplu.ro"],
    ["domeniu fără punct", "client@exemplu"],
    ["spațiu în mijloc", "cli ent@exemplu.ro"],
    ["două @", "a@b@exemplu.ro"],
    ["virgulă în loc de punct", "client@exemplu,ro"],
  ])("respinge: %s", (_label, value) => {
    expect(() => normalizeAlertEmail(value)).toThrow(ValidationError);
  });

  it("respinge ce nu e text", () => {
    for (const value of [null, undefined, 42, {}, ["a@b.ro"]]) {
      expect(() => normalizeAlertEmail(value)).toThrow(ValidationError);
    }
  });

  it("respinge peste 254 de caractere și acceptă exact 254", () => {
    const tail = "@exemplu.ro";
    const exact = `${"a".repeat(254 - tail.length)}${tail}`;
    expect(exact).toHaveLength(254);
    expect(normalizeAlertEmail(exact)).toBe(exact);
    expect(() => normalizeAlertEmail(`a${exact}`)).toThrow(ValidationError);
  });

  it("nu scrie adresa în mesajul erorii (nu ajunge în loguri)", () => {
    try {
      normalizeAlertEmail("persoana-fara-arond@");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("persoana-fara-arond");
      expect(JSON.stringify((error as ValidationError).details ?? null)).not.toContain(
        "persoana-fara-arond",
      );
    }
  });
});
