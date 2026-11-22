import { describe, expect, it } from "vitest";
import { quantityFromTicks, type Quantity } from "@ecom/shared";
import { RETURN_STATUSES, isCustomerVisibleReturnEvent } from "./return-constants";
import {
  activeReturnQuantity,
  checkReturnQuantity,
  isReturnWindowOpen,
  returnWindowEnd,
  returnableQuantity,
} from "./return-eligibility";
import {
  RETURN_TRANSITIONS,
  assertReturnTransition,
  canTransitionReturn,
  isFinalReturnStatus,
} from "./return-state";

const q = (ticks: number | bigint): Quantity => quantityFromTicks(ticks);
// ceasul se injectează: nicio dată nu e comparată cu ora reală
const NOW = new Date("2030-06-15T12:00:00.000Z");
const days = (n: number): number => n * 24 * 60 * 60 * 1000;

describe("fereastra de retur", () => {
  it("se închide după 14 zile întregi de la livrare, inclusiv momentul limită", () => {
    const delivered = new Date(NOW.getTime() - days(14));
    expect(returnWindowEnd(delivered, 14).getTime()).toBe(NOW.getTime());
    expect(isReturnWindowOpen(NOW, delivered, 14)).toBe(true);
    expect(isReturnWindowOpen(new Date(NOW.getTime() + 1), delivered, 14)).toBe(false);
  });

  it("e deschisă în ziua livrării și la 13 zile", () => {
    expect(isReturnWindowOpen(NOW, NOW, 14)).toBe(true);
    expect(isReturnWindowOpen(NOW, new Date(NOW.getTime() - days(13)), 14)).toBe(true);
  });

  it("valoarea din setare se respectă: 30 de zile", () => {
    const delivered = new Date(NOW.getTime() - days(20));
    expect(isReturnWindowOpen(NOW, delivered, 14)).toBe(false);
    expect(isReturnWindowOpen(NOW, delivered, 30)).toBe(true);
  });

  it("refuză o fereastră care nu e un număr întreg pozitiv de zile", () => {
    expect(() => returnWindowEnd(NOW, 0)).toThrow(RangeError);
    expect(() => returnWindowEnd(NOW, 1.5)).toThrow(RangeError);
    expect(() => returnWindowEnd(NOW, -3)).toThrow(RangeError);
  });
});

describe("cantități returnabile", () => {
  it("cantitatea activă: cerută până la inspecție, acceptată după, zero la respins sau anulat", () => {
    expect(activeReturnQuantity("requested", q(30_000), null)).toBe(q(30_000));
    expect(activeReturnQuantity("received", q(30_000), null)).toBe(q(30_000));
    expect(activeReturnQuantity("inspected", q(30_000), q(10_000))).toBe(q(10_000));
    expect(activeReturnQuantity("refunded", q(30_000), q(10_000))).toBe(q(10_000));
    expect(activeReturnQuantity("inspected", q(30_000), null)).toBe(q(0));
    expect(activeReturnQuantity("rejected", q(30_000), q(30_000))).toBe(q(0));
    expect(activeReturnQuantity("cancelled", q(30_000), null)).toBe(q(0));
  });

  it("restul returnabil nu coboară sub zero", () => {
    expect(returnableQuantity(q(30_000), q(10_000))).toBe(q(20_000));
    expect(returnableQuantity(q(30_000), q(30_000))).toBe(q(0));
    expect(returnableQuantity(q(30_000), q(40_000))).toBe(q(0));
  });

  it("verifică cantitatea cerută: pozitivă, multiplu al pasului, cel mult cât a rămas", () => {
    const step = q(10_000); // buc
    expect(checkReturnQuantity(q(10_000), q(20_000), step)).toBeNull();
    expect(checkReturnQuantity(q(20_000), q(20_000), step)).toBeNull();
    expect(checkReturnQuantity(q(0), q(20_000), step)).toBe("not_positive");
    expect(checkReturnQuantity(q(5_000), q(20_000), step)).toBe("not_step_multiple");
    expect(checkReturnQuantity(q(30_000), q(20_000), step)).toBe("exceeds_returnable");
  });

  it("pasul zecimal (0,5 mp): multipli exacți, fără rotunjire", () => {
    const step = q(5_000);
    expect(checkReturnQuantity(q(25_000), q(60_900), step)).toBeNull();
    expect(checkReturnQuantity(q(25_001), q(60_900), step)).toBe("not_step_multiple");
    expect(checkReturnQuantity(q(60_000), q(60_900), step)).toBeNull();
    expect(checkReturnQuantity(q(65_000), q(60_900), step)).toBe("exceeds_returnable");
  });
});

describe("state machine-ul returului", () => {
  const ALLOWED: ReadonlyArray<[string, string]> = [
    ["requested", "approved"],
    ["requested", "rejected"],
    ["requested", "cancelled"],
    ["approved", "awaiting_shipment"],
    ["approved", "cancelled"],
    ["awaiting_shipment", "received"],
    ["awaiting_shipment", "cancelled"],
    ["received", "inspected"],
    ["inspected", "refunded"],
    ["inspected", "rejected"],
  ];

  it("permite exact cele 10 tranziții din docs/04", () => {
    const all = RETURN_STATUSES.flatMap((from) =>
      RETURN_STATUSES.filter((to) => canTransitionReturn(from, to)).map((to) => [from, to]),
    );
    expect(all).toEqual(ALLOWED);
  });

  it("refuză orice alt salt (de exemplu requested → refunded, received → cancelled)", () => {
    expect(() => assertReturnTransition("requested", "refunded")).toThrow(/nu este permisă/);
    expect(canTransitionReturn("received", "cancelled")).toBe(false);
    expect(canTransitionReturn("inspected", "cancelled")).toBe(false);
    expect(canTransitionReturn("approved", "received")).toBe(false);
    expect(canTransitionReturn("nimic", "approved")).toBe(false);
  });

  it("stările finale nu mai au ieșiri", () => {
    for (const s of ["refunded", "rejected", "cancelled"]) {
      expect(isFinalReturnStatus(s)).toBe(true);
      expect(RETURN_TRANSITIONS[s as keyof typeof RETURN_TRANSITIONS]).toEqual([]);
    }
    expect(isFinalReturnStatus("requested")).toBe(false);
  });
});

describe("evenimente vizibile clientului", () => {
  it("doar lista albă; nimic intern", () => {
    expect(isCustomerVisibleReturnEvent("return.approved")).toBe(true);
    expect(isCustomerVisibleReturnEvent("return.note")).toBe(false);
    expect(isCustomerVisibleReturnEvent("return.admin_note")).toBe(false);
    expect(isCustomerVisibleReturnEvent("return.storno_failed")).toBe(false);
    expect(isCustomerVisibleReturnEvent("return.restocked")).toBe(false);
  });
});
