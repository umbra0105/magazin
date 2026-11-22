import { describe, expect, it } from "vitest";
import {
  INVOICE_TRIGGER_EVENT_TYPES,
  invoiceActionsFor,
  invoicePaymentType,
  type InvoiceOrderFacts,
} from "./invoice-rules";

/**
 * Momentul emiterii, după metoda de plată (docs/10, Partea I): card = la plata confirmată; transfer = proformă la plasare, factură
 * după confirmarea plății; ramburs = la plasare (la expediere dacă are linii «La comandă»); anulare, refuz de ramburs și rambursare
 * TOTALĂ = storno; rambursarea parțială nu stornează nimic; comenzile de pe canale externe nu se facturează de aici.
 */
const facts = (over: Partial<InvoiceOrderFacts> = {}): InvoiceOrderFacts => ({
  paymentMethod: "card",
  paymentStatus: "pending",
  external: false,
  hasOnOrderLine: false,
  ...over,
});

const issue = (kind: "proforma" | "invoice") => [{ action: "issue", kind }];
const reverse = [{ action: "reverse" }];

describe("momentul emiterii, după metoda de plată", () => {
  it("card: nimic la plasare; factura la plata confirmată", () => {
    expect(invoiceActionsFor("order.placed", facts({ paymentMethod: "card" }))).toEqual([]);
    expect(invoiceActionsFor("payment.confirmed", facts({ paymentMethod: "card" }))).toEqual(
      issue("invoice"),
    );
  });

  it("transfer bancar: proformă la plasare; factura după ce adminul confirmă plata", () => {
    expect(invoiceActionsFor("order.placed", facts({ paymentMethod: "bank_transfer" }))).toEqual(
      issue("proforma"),
    );
    expect(
      invoiceActionsFor("payment.confirmed", facts({ paymentMethod: "bank_transfer" })),
    ).toEqual(issue("invoice"));
  });

  it("ramburs: factura la plasare; încasarea de la curier nu emite o a doua factură", () => {
    expect(invoiceActionsFor("order.placed", facts({ paymentMethod: "cod" }))).toEqual(
      issue("invoice"),
    );
    expect(invoiceActionsFor("payment.confirmed", facts({ paymentMethod: "cod" }))).toEqual([]);
  });

  it("«La comandă» la ramburs: factura abia la expediere; la card sau transfer, la plată ca oricând", () => {
    const cod = facts({ paymentMethod: "cod", hasOnOrderLine: true });
    expect(invoiceActionsFor("order.placed", cod)).toEqual([]);
    expect(invoiceActionsFor("order.shipped", cod)).toEqual(issue("invoice"));
    expect(invoiceActionsFor("order.shipped", facts({ paymentMethod: "cod" }))).toEqual([]);
    expect(
      invoiceActionsFor(
        "payment.confirmed",
        facts({ paymentMethod: "card", hasOnOrderLine: true }),
      ),
    ).toEqual(issue("invoice"));
    // expedierea nu emite o factură la card/transfer (a fost emisă la plată)
    expect(
      invoiceActionsFor("order.shipped", facts({ paymentMethod: "card", hasOnOrderLine: true })),
    ).toEqual([]);
  });
});

describe("storno", () => {
  for (const event of ["order.cancelled", "order.auto_cancelled", "order.returned_to_sender"]) {
    it(`${event}: stornează (sau anulează proforma)`, () => {
      for (const paymentMethod of ["card", "cod", "bank_transfer"] as const) {
        expect(invoiceActionsFor(event, facts({ paymentMethod }))).toEqual(reverse);
      }
    });
  }

  it("rambursare TOTALĂ: storno; PARȚIALĂ sau în așteptare: nimic", () => {
    expect(invoiceActionsFor("payment.refunded", facts({ paymentStatus: "refunded" }))).toEqual(
      reverse,
    );
    expect(
      invoiceActionsFor("payment.refunded", facts({ paymentStatus: "partially_refunded" })),
    ).toEqual([]);
    expect(invoiceActionsFor("payment.refunded", facts({ paymentStatus: "paid" }))).toEqual([]);
  });
});

describe("ce nu se facturează de aici", () => {
  it("comenzile de pe canale externe: nicio acțiune, la niciun eveniment", () => {
    for (const event of INVOICE_TRIGGER_EVENT_TYPES) {
      for (const paymentMethod of ["card", "cod", "bank_transfer"] as const) {
        expect(
          invoiceActionsFor(
            event,
            facts({ external: true, paymentMethod, paymentStatus: "refunded" }),
          ),
        ).toEqual([]);
      }
    }
  });

  it("evenimentele fără regulă nu fac nimic", () => {
    for (const event of [
      "order.processing",
      "payment.attention",
      "order.delivered",
      "nu.exista",
      "",
    ]) {
      expect(invoiceActionsFor(event, facts({ paymentMethod: "cod" }))).toEqual([]);
    }
  });

  it("lista evenimentelor declanșatoare conține exact ce folosesc regulile", () => {
    expect([...INVOICE_TRIGGER_EVENT_TYPES].sort()).toEqual(
      [
        "order.placed",
        "payment.confirmed",
        "order.shipped",
        "order.cancelled",
        "order.auto_cancelled",
        "order.returned_to_sender",
        "payment.refunded",
      ].sort(),
    );
  });
});

describe("încasarea trecută pe factură", () => {
  it("card → «Card online», transfer → «Ordin plata», ramburs → neîncasat încă", () => {
    expect(invoicePaymentType("card")).toBe("Card online");
    expect(invoicePaymentType("bank_transfer")).toBe("Ordin plata");
    expect(invoicePaymentType("cod")).toBeNull();
  });
});
