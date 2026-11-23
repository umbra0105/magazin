import { describe, expect, it } from "vitest";
import {
  DIGITAL_CONSENT_DEFAULT_TEXT,
  DIGITAL_CONSENT_DEFAULT_VERSION,
  consentSnapshot,
  decideGrant,
  decideRevocation,
  distinctIpCount,
  generateAccessToken,
  isIpAnomaly,
  isValidAccessToken,
  type GrantFacts,
} from "./digital-rules";

const base: GrantFacts = {
  paymentMethod: "card",
  paymentStatus: "pending",
  status: "pending",
  fulfillmentStatus: "unfulfilled",
  hasDigital: true,
  hasPhysical: false,
};
const facts = (patch: Partial<GrantFacts>): GrantFacts => ({ ...base, ...patch });

describe("decideGrant: când se acordă accesul (decizia 1)", () => {
  it("card: nu înainte de plata confirmată, da după", () => {
    expect(decideGrant(facts({ paymentMethod: "card", paymentStatus: "pending" })).grant).toBe(
      false,
    );
    expect(decideGrant(facts({ paymentMethod: "card", paymentStatus: "authorized" })).grant).toBe(
      false,
    );
    expect(decideGrant(facts({ paymentMethod: "card", paymentStatus: "failed" })).grant).toBe(
      false,
    );
    expect(decideGrant(facts({ paymentMethod: "card", paymentStatus: "paid" }))).toEqual({
      grant: true,
      reason: "payment",
    });
  });

  it("transfer bancar: doar după «Marchează plătit» (plătit)", () => {
    expect(decideGrant(facts({ paymentMethod: "bank_transfer" })).grant).toBe(false);
    expect(decideGrant(facts({ paymentMethod: "bank_transfer", paymentStatus: "paid" }))).toEqual({
      grant: true,
      reason: "payment",
    });
  });

  it("ramburs în comandă mixtă: NU la plasare, NU la expediere, NU la încasarea de la curier; doar la livrare confirmată", () => {
    const mixed = {
      paymentMethod: "cod" as const,
      hasPhysical: true,
      status: "confirmed" as const,
    };
    expect(decideGrant(facts({ ...mixed })).grant).toBe(false);
    for (const fulfillmentStatus of ["fulfilled", "in_transit", "partially_fulfilled"] as const) {
      expect(decideGrant(facts({ ...mixed, fulfillmentStatus })).grant).toBe(false);
    }
    // banii virați de curier înainte de livrarea marcată nu schimbă nimic
    expect(
      decideGrant(facts({ ...mixed, paymentStatus: "paid", fulfillmentStatus: "in_transit" }))
        .grant,
    ).toBe(false);
    expect(decideGrant(facts({ ...mixed, fulfillmentStatus: "delivered" }))).toEqual({
      grant: true,
      reason: "delivery",
    });
  });

  it("ramburs fără nicio linie fizică nu există: nu se acordă niciodată", () => {
    expect(
      decideGrant(
        facts({
          paymentMethod: "cod",
          hasPhysical: false,
          status: "confirmed",
          paymentStatus: "paid",
          fulfillmentStatus: "delivered",
        }),
      ).grant,
    ).toBe(false);
  });

  it("o comandă anulată, returnată sau rambursată integral nu primește acces, oricât de «plătită» ar fi fost", () => {
    const paid = { paymentStatus: "paid" as const };
    expect(decideGrant(facts({ ...paid, status: "cancelled" })).grant).toBe(false);
    expect(decideGrant(facts({ ...paid, status: "returned" })).grant).toBe(false);
    for (const paymentStatus of ["refunded", "chargeback", "cancelled", "failed"] as const) {
      expect(decideGrant(facts({ paymentStatus })).grant).toBe(false);
    }
    expect(
      decideGrant(
        facts({
          paymentMethod: "cod",
          hasPhysical: true,
          fulfillmentStatus: "delivered",
          status: "cancelled",
        }),
      ).grant,
    ).toBe(false);
    expect(
      decideGrant(
        facts({
          paymentMethod: "cod",
          hasPhysical: true,
          fulfillmentStatus: "returned",
          status: "confirmed",
        }),
      ).grant,
    ).toBe(false);
  });

  it("rambursarea parțială a plății nu retrage accesul la celelalte linii", () => {
    expect(decideGrant(facts({ paymentStatus: "partially_refunded" })).grant).toBe(true);
  });

  it("fără linii digitale nu se acordă nimic", () => {
    expect(decideGrant(facts({ paymentStatus: "paid", hasDigital: false })).grant).toBe(false);
  });
});

describe("decideRevocation: când se retrage accesul de pe toată comanda", () => {
  it("rambursare integrală, chargeback, anulare: da", () => {
    expect(decideRevocation({ paymentStatus: "refunded", status: "confirmed" })).toBe(
      "Comanda a fost rambursată integral",
    );
    expect(decideRevocation({ paymentStatus: "chargeback", status: "confirmed" })).toBe(
      "Plata a fost contestată (chargeback)",
    );
    expect(decideRevocation({ paymentStatus: "paid", status: "cancelled" })).toBe(
      "Comanda a fost anulată",
    );
  });

  it("plătită, rambursată parțial sau în așteptare: nu", () => {
    for (const paymentStatus of ["pending", "authorized", "paid", "partially_refunded"] as const) {
      expect(decideRevocation({ paymentStatus, status: "confirmed" })).toBeNull();
    }
  });
});

describe("jetonul de acces", () => {
  it("are cel puțin 32 de caractere, e unic și opac", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = generateAccessToken();
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(isValidAccessToken(token)).toBe(true);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });

  it.each([
    "",
    "scurt",
    "a".repeat(31),
    "a".repeat(129),
    `${"a".repeat(40)}/../x`,
    "a b".repeat(20),
  ])("refuză un jeton cu formă greșită (%s)", (value) => {
    expect(isValidAccessToken(value)).toBe(false);
  });
});

describe("alerta de tipar anormal (adrese IP distincte)", () => {
  it("numără adresele distincte, ignoră nulele", () => {
    expect(distinctIpCount(["1.1.1.1", "1.1.1.1", null, "2.2.2.2", null])).toBe(2);
  });

  it("pragul e STRICT: exact pragul nu alertează, pragul + 1 da", () => {
    const five = ["1", "2", "3", "4", "5"];
    expect(isIpAnomaly(five, 5)).toBe(false);
    expect(isIpAnomaly([...five, "6"], 5)).toBe(true);
  });
});

describe("textul bifei legale", () => {
  it("fără text propriu: textul și versiunea implicite", () => {
    expect(consentSnapshot("")).toEqual({
      text: DIGITAL_CONSENT_DEFAULT_TEXT,
      version: DIGITAL_CONSENT_DEFAULT_VERSION,
    });
    expect(consentSnapshot("   ")).toEqual({
      text: DIGITAL_CONSENT_DEFAULT_TEXT,
      version: DIGITAL_CONSENT_DEFAULT_VERSION,
    });
  });

  it("textul implicit cere livrarea imediată și confirmă pierderea dreptului de retragere", () => {
    expect(DIGITAL_CONSENT_DEFAULT_TEXT).toMatch(/livrarea imediată/);
    expect(DIGITAL_CONSENT_DEFAULT_TEXT).toMatch(/dreptul de retragere/);
  });

  it("un text propriu primește o versiune derivată din conținut: alt text, altă versiune", () => {
    const a = consentSnapshot("Solicit livrarea imediată a cursului.");
    const b = consentSnapshot("Solicit livrarea imediată a cursului!");
    expect(a.text).toBe("Solicit livrarea imediată a cursului.");
    expect(a.version).not.toBe(DIGITAL_CONSENT_DEFAULT_VERSION);
    expect(a.version).not.toBe(b.version);
    expect(consentSnapshot("Solicit livrarea imediată a cursului.").version).toBe(a.version);
  });
});
