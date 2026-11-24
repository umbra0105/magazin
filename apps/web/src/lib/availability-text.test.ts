import { describe, expect, it } from "vitest";
import { describeAvailability } from "./availability-text";

/**
 * Eticheta comună de disponibilitate (Faza 14c, decizia 3): produsele fizice păstrează cele patru stări vizibile; produsul
 * digital arată DOAR «Disponibil» sau «Indisponibil», niciodată «În stoc», «Stoc limitat» sau «La comandă». Un singur loc,
 * folosit de carduri, căutare, favorite, pagina de produs și coș.
 */
const FORBIDDEN_FOR_DIGITAL = ["În stoc", "Stoc limitat", "La comandă"];

describe("describeAvailability", () => {
  it("produs fizic: cele patru stări vizibile, cu aceleași etichete, tonuri și detalii ca înainte", () => {
    expect(describeAvailability({ state: "in_stock" })).toEqual({
      label: "În stoc",
      tone: "success",
      detail: null,
    });
    expect(describeAvailability({ state: "limited", remainingSteps: 3 })).toEqual({
      label: "Stoc limitat",
      tone: "warning",
      detail: "Mai sunt 3",
    });
    expect(describeAvailability({ state: "on_order", leadTimeDays: 5 })).toEqual({
      label: "La comandă",
      tone: "info",
      detail: "livrare în aproximativ 5 zile",
    });
    expect(describeAvailability({ state: "unavailable" })).toEqual({
      label: "Indisponibil",
      tone: "problem",
      detail: null,
    });
  });

  it("produs digital comandabil: «Disponibil», fără detaliu de stoc sau de termen", () => {
    const result = describeAvailability({ state: "in_stock", isDigital: true, purchasable: true });
    expect(result).toEqual({ label: "Disponibil", tone: "success", detail: null });
  });

  it("produs digital necomandabil: «Indisponibil»", () => {
    expect(describeAvailability({ state: "unavailable", isDigital: true })).toEqual({
      label: "Indisponibil",
      tone: "problem",
      detail: null,
    });
    expect(
      describeAvailability({ state: "in_stock", isDigital: true, purchasable: false }),
    ).toEqual({ label: "Indisponibil", tone: "problem", detail: null });
  });

  it("produsul digital nu primește niciodată etichetele de stoc, oricare ar fi starea primită", () => {
    for (const state of ["in_stock", "limited", "on_order", "unavailable"] as const) {
      const result = describeAvailability({
        state,
        isDigital: true,
        remainingSteps: 2,
        leadTimeDays: 7,
      });
      expect(FORBIDDEN_FOR_DIGITAL).not.toContain(result.label);
      expect(result.detail).toBeNull();
      expect(["Disponibil", "Indisponibil"]).toContain(result.label);
    }
  });
});
