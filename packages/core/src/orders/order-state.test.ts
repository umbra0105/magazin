import { describe, expect, it } from "vitest";
import {
  FULFILLMENT_TRANSITIONS,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  assertTransition,
  canTransition,
} from "./order-state";

describe("state machine: Order.status", () => {
  it("fluxul principal: draft → pending → confirmed → processing → completed", () => {
    for (const [from, to] of [
      ["draft", "pending"],
      ["pending", "confirmed"],
      ["confirmed", "processing"],
      ["processing", "completed"],
    ] as const) {
      expect(canTransition("status", from, to), `${from} → ${to}`).toBe(true);
    }
  });

  it("anularea e posibilă din pending, confirmed și processing, nu din completed", () => {
    for (const from of ["pending", "confirmed", "processing"] as const) {
      expect(canTransition("status", from, "cancelled"), from).toBe(true);
    }
    expect(canTransition("status", "completed", "cancelled")).toBe(false);
  });

  it("completed → returned; nimic nu iese din cancelled sau returned", () => {
    expect(canTransition("status", "completed", "returned")).toBe(true);
    for (const to of Object.keys(ORDER_TRANSITIONS)) {
      expect(canTransition("status", "cancelled", to as never)).toBe(false);
      expect(canTransition("status", "returned", to as never)).toBe(false);
    }
  });

  it("nu se sare peste pași și nu se merge înapoi", () => {
    expect(canTransition("status", "pending", "completed")).toBe(false);
    expect(canTransition("status", "pending", "processing")).toBe(false);
    expect(canTransition("status", "confirmed", "pending")).toBe(false);
    expect(canTransition("status", "completed", "processing")).toBe(false);
  });

  it("o stare nu trece în ea însăși", () => {
    for (const state of Object.keys(ORDER_TRANSITIONS)) {
      expect(canTransition("status", state as never, state as never)).toBe(false);
    }
  });
});

describe("state machine: Order.paymentStatus", () => {
  it("pending → authorized | paid | failed | cancelled", () => {
    for (const to of ["authorized", "paid", "failed", "cancelled"] as const) {
      expect(canTransition("paymentStatus", "pending", to), to).toBe(true);
    }
  });
  it("authorized → paid | cancelled; paid → partially_refunded | refunded | chargeback", () => {
    expect(canTransition("paymentStatus", "authorized", "paid")).toBe(true);
    expect(canTransition("paymentStatus", "authorized", "cancelled")).toBe(true);
    for (const to of ["partially_refunded", "refunded", "chargeback"] as const) {
      expect(canTransition("paymentStatus", "paid", to), to).toBe(true);
    }
    expect(canTransition("paymentStatus", "partially_refunded", "refunded")).toBe(true);
  });
  it("o comandă anulată nu devine plătită, iar plata eșuată nu devine plătită fără o plată nouă", () => {
    expect(canTransition("paymentStatus", "cancelled", "paid")).toBe(false);
    expect(canTransition("paymentStatus", "failed", "paid")).toBe(false);
    expect(canTransition("paymentStatus", "refunded", "paid")).toBe(false);
  });
});

describe("state machine: Order.fulfillmentStatus", () => {
  it("unfulfilled → partially_fulfilled → fulfilled → in_transit → delivered", () => {
    for (const [from, to] of [
      ["unfulfilled", "partially_fulfilled"],
      ["partially_fulfilled", "fulfilled"],
      ["fulfilled", "in_transit"],
      ["in_transit", "delivered"],
      ["unfulfilled", "fulfilled"],
    ] as const) {
      expect(canTransition("fulfillmentStatus", from, to), `${from} → ${to}`).toBe(true);
    }
  });
  it("anulare doar din unfulfilled; returned după expediere", () => {
    expect(canTransition("fulfillmentStatus", "unfulfilled", "cancelled")).toBe(true);
    expect(canTransition("fulfillmentStatus", "fulfilled", "cancelled")).toBe(false);
    expect(canTransition("fulfillmentStatus", "delivered", "returned")).toBe(true);
    expect(canTransition("fulfillmentStatus", "unfulfilled", "delivered")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("aruncă ORDER_TRANSITION_INVALID cu starea veche, cea nouă și câmpul", () => {
    try {
      assertTransition("status", "completed", "pending");
      throw new Error("trebuia să arunce");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ORDER_TRANSITION_INVALID",
        details: { field: "status", from: "completed", to: "pending" },
      });
    }
  });
  it("nu aruncă pentru o tranziție permisă", () => {
    expect(() => assertTransition("paymentStatus", "pending", "paid")).not.toThrow();
  });
  it("tabelele acoperă toate stările din CHECK-urile bazei", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(
      ["cancelled", "completed", "confirmed", "draft", "pending", "processing", "returned"].sort(),
    );
    expect(Object.keys(PAYMENT_TRANSITIONS).sort()).toEqual(
      [
        "authorized",
        "cancelled",
        "chargeback",
        "failed",
        "paid",
        "partially_refunded",
        "pending",
        "refunded",
      ].sort(),
    );
    expect(Object.keys(FULFILLMENT_TRANSITIONS).sort()).toEqual(
      [
        "cancelled",
        "delivered",
        "fulfilled",
        "in_transit",
        "partially_fulfilled",
        "returned",
        "unfulfilled",
      ].sort(),
    );
  });
});
