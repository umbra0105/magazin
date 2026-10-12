import { describe, expect, it } from "vitest";
import { roCount } from "./messages";
import { renderEmail } from "./render";
import type { EmailTheme } from "./theme";

const theme: EmailTheme = {
  storeName: "Piscine Demo",
  logoUrl: null,
  colors: {
    bg: "#fafafa",
    fg: "#111111",
    muted: "#555555",
    border: "#dddddd",
    primary: "#0b5fff",
    primaryFg: "#ffffff",
  },
  fontFamily: "Arial, Helvetica, sans-serif",
  radiusPx: 8,
};

const LINK = "https://magazin.example/resetare-parola#token=abcDEF123_-xyz";

describe("șabloanele de email", () => {
  it("verificare: română, linkul în buton și în text, valabilitate de 24 de ore", async () => {
    const email = await renderEmail(theme, {
      kind: "verify-email",
      name: "Ana",
      link: LINK,
      validForHours: 24,
    });
    expect(email.subject).toBe("Confirmă adresa de email – Piscine Demo");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("Bună, Ana,");
      expect(part).toContain("Confirmă adresa de email");
      expect(part).toContain("24 de ore");
      expect(part).toContain("o singură dată");
      expect(part).toContain(LINK);
      expect(part).toContain("Piscine Demo");
    }
    expect(email.html).toContain(`href="${LINK}"`);
  });

  it("resetare: 1 oră, unică folosință, textul despre deconectare", async () => {
    const email = await renderEmail(theme, {
      kind: "reset-password",
      name: "",
      link: LINK,
      validForMinutes: 60,
    });
    expect(email.subject).toBe("Resetarea parolei – Piscine Demo");
    expect(email.text).toContain("Bună,");
    expect(email.text).toContain("1 oră");
    expect(email.text).toContain("deconectat de pe toate dispozitivele");
    expect(email.text).toContain(LINK);
  });

  it("aspectul vine din tokens (tema): culorile apar inline, fără CSS variables sau culori fixe", async () => {
    const { html } = await renderEmail(theme, {
      kind: "reset-password",
      name: "Ana",
      link: LINK,
      validForMinutes: 60,
    });
    for (const color of Object.values(theme.colors)) {
      expect(html.toLowerCase()).toContain(color.toLowerCase());
    }
    expect(html).not.toContain("var(--");
    expect(html).toContain("border-radius:8px");

    const other = await renderEmail(
      { ...theme, colors: { ...theme.colors, primary: "#ff0066" } },
      { kind: "reset-password", name: "Ana", link: LINK, validForMinutes: 60 },
    );
    expect(other.html.toLowerCase()).toContain("#ff0066");
    expect(other.html.toLowerCase()).not.toContain("#0b5fff");
  });

  it("logo configurat: imaginea apare în loc de nume", async () => {
    const { html } = await renderEmail(
      { ...theme, logoUrl: "https://magazin.example/logo.png" },
      { kind: "verify-email", name: "Ana", link: LINK, validForHours: 24 },
    );
    expect(html).toContain('src="https://magazin.example/logo.png"');
  });
});

describe("roCount (acord românesc)", () => {
  it("1 oră, 2 ore, 19 ore, 20 de ore, 24 de ore, 101 ore, 120 de ore", () => {
    const hours = (n: number) => roCount(n, "oră", "ore", "ore");
    expect(hours(1)).toBe("1 oră");
    expect(hours(2)).toBe("2 ore");
    expect(hours(19)).toBe("19 ore");
    expect(hours(20)).toBe("20 de ore");
    expect(hours(24)).toBe("24 de ore");
    expect(hours(101)).toBe("101 ore");
    expect(hours(120)).toBe("120 de ore");
  });
  it("minute: 30 de minute, 5 minute", () => {
    expect(roCount(30, "minut", "minute", "minute")).toBe("30 de minute");
    expect(roCount(5, "minut", "minute", "minute")).toBe("5 minute");
  });
});
