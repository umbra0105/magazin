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

describe("emailul «Anunță-mă când revine»", () => {
  const PRODUCT_LINK = "https://magazin.example/produs/pompa-caldura-12";
  const content = {
    kind: "back-in-stock" as const,
    productTitle: "Pompă de căldură 12 kW",
    variantLabel: "Alb · 230 V" as string | null,
    link: PRODUCT_LINK,
  };

  it("subiect, textul aprobat, butonul «Vezi produsul» și linkul spre produs (HTML și text)", async () => {
    const email = await renderEmail(theme, content);
    expect(email.subject).toBe("Piscine Demo: Pompă de căldură 12 kW e din nou în stoc");
    for (const part of [email.html, email.text]) {
      expect(part).toContain("Bună,");
      expect(part).toContain(
        "Produsul pe care îl așteptai, Pompă de căldură 12 kW (Alb · 230 V), este din nou disponibil.",
      );
      expect(part).toContain(
        "Acesta este singurul mesaj pe care îl primești pentru această cerere; adresa ta a fost ștearsă.",
      );
      expect(part).toContain(
        "Dacă nu ai cerut tu această notificare, poți ignora mesajul; adresa ta a fost ștearsă și nu vei mai primi altele.",
      );
      expect(part).toContain("Vezi produsul");
      expect(part).toContain(PRODUCT_LINK);
    }
    expect(email.html).toContain(`href="${PRODUCT_LINK}"`);
  });

  it("fără variantă (produs simplu): titlul apare fără paranteze goale", async () => {
    const email = await renderEmail(theme, { ...content, variantLabel: null });
    expect(email.text).toContain("Produsul pe care îl așteptai, Pompă de căldură 12 kW, este din");
    expect(email.text).not.toContain("()");
  });

  it("un mesaj de serviciu: nicio valabilitate de link, nicio frază de resetare, nicio promoție", async () => {
    const email = await renderEmail(theme, content);
    for (const part of [email.html, email.text]) {
      expect(part).not.toContain("valabil ");
      expect(part).not.toContain("Dacă nu ai cerut tu acest mesaj");
    }
    // singurele legături: butonul, linkul de rezervă (același URL) — fără imagini, pixeli de urmărire sau alte adrese
    const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(new Set([PRODUCT_LINK]));
    expect(email.html).not.toContain("<img");
  });

  it("titlul produsului e codificat în HTML (nu se poate injecta marcaj)", async () => {
    const email = await renderEmail(theme, {
      ...content,
      productTitle: '<script>alert("x")</script> Pompă',
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("subiectul rămâne pe o linie, chiar dacă titlul are rânduri noi", async () => {
    const email = await renderEmail(theme, { ...content, productTitle: "Pompă\r\nBcc: x@y.test" });
    expect(email.subject).not.toMatch(/[\r\n]/);
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
