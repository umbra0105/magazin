import { describe, expect, it } from "vitest";
import {
  publicAvailabilityOfRow,
  summarizeProductAvailability,
  type PublicAvailability,
} from "./public-availability";

const av = (
  state: PublicAvailability["state"],
  extra: Partial<PublicAvailability> = {},
): PublicAvailability => ({
  state,
  purchasable: state !== "unavailable",
  leadTimeDays: null,
  remainingSteps: null,
  ...extra,
});

describe("publicAvailabilityOfRow (ce are voie să vadă cumpărătorul)", () => {
  it("«Stoc limitat» arată câți pași mai sunt; nimic altceva din cantități nu iese", () => {
    expect(
      publicAvailabilityOfRow({ state: "limited", leadTimeDays: null, availableSteps: 3n }),
    ).toEqual({ state: "limited", purchasable: true, leadTimeDays: null, remainingSteps: 3 });
  });

  it("«În stoc» nu dezvăluie cantitatea, chiar dacă rândul o are", () => {
    expect(
      publicAvailabilityOfRow({ state: "in_stock", leadTimeDays: null, availableSteps: 500n }),
    ).toEqual({ state: "in_stock", purchasable: true, leadTimeDays: null, remainingSteps: null });
  });

  it("«La comandă» poartă termenul în zile; «Indisponibil» nu se poate cumpăra", () => {
    expect(
      publicAvailabilityOfRow({ state: "on_order", leadTimeDays: 14, availableSteps: 0n }),
    ).toEqual({ state: "on_order", purchasable: true, leadTimeDays: 14, remainingSteps: null });
    expect(
      publicAvailabilityOfRow({ state: "unavailable", leadTimeDays: null, availableSteps: 0n }),
    ).toEqual({
      state: "unavailable",
      purchasable: false,
      leadTimeDays: null,
      remainingSteps: null,
    });
  });

  it("termenul de livrare apare doar la «La comandă», nu și la alte stări", () => {
    expect(
      publicAvailabilityOfRow({ state: "in_stock", leadTimeDays: 5, availableSteps: null }),
    ).toMatchObject({ leadTimeDays: null });
  });

  it("negestionat: fără pași (null) nu apare nicio cantitate", () => {
    expect(
      publicAvailabilityOfRow({ state: "limited", leadTimeDays: null, availableSteps: null }),
    ).toMatchObject({ remainingSteps: null });
  });
});

describe("summarizeProductAvailability (starea unui produs cu mai multe variante)", () => {
  it("fără variante: indisponibil", () => {
    expect(summarizeProductAvailability([])).toEqual(av("unavailable"));
  });

  it("ordinea: în stoc, apoi stoc limitat, apoi la comandă, apoi indisponibil", () => {
    expect(
      summarizeProductAvailability([
        av("unavailable"),
        av("on_order", { leadTimeDays: 7 }),
        av("in_stock"),
      ]),
    ).toMatchObject({ state: "in_stock" });
    expect(
      summarizeProductAvailability([
        av("unavailable"),
        av("on_order", { leadTimeDays: 7 }),
        av("limited", { remainingSteps: 2 }),
      ]),
    ).toMatchObject({ state: "limited" });
    expect(
      summarizeProductAvailability([av("unavailable"), av("on_order", { leadTimeDays: 7 })]),
    ).toMatchObject({ state: "on_order", leadTimeDays: 7, purchasable: true });
    expect(summarizeProductAvailability([av("unavailable"), av("unavailable")])).toMatchObject({
      state: "unavailable",
      purchasable: false,
    });
  });

  it("«În stoc» bate «Stoc limitat» (și invers nu)", () => {
    expect(
      summarizeProductAvailability([av("limited", { remainingSteps: 1 }), av("in_stock")]),
    ).toMatchObject({ state: "in_stock" });
    expect(
      summarizeProductAvailability([av("in_stock"), av("limited", { remainingSteps: 1 })]),
    ).toMatchObject({ state: "in_stock" });
  });

  it("la comandă: termenul cel mai scurt dintre variantele la comandă", () => {
    expect(
      summarizeProductAvailability([
        av("on_order", { leadTimeDays: 21 }),
        av("on_order", { leadTimeDays: 7 }),
        av("on_order", { leadTimeDays: 14 }),
      ]),
    ).toMatchObject({ leadTimeDays: 7 });
  });

  it("numărul de pași rămași apare doar la un produs cu o singură variantă", () => {
    expect(summarizeProductAvailability([av("limited", { remainingSteps: 2 })])).toMatchObject({
      remainingSteps: 2,
    });
    expect(
      summarizeProductAvailability([av("limited", { remainingSteps: 2 }), av("unavailable")]),
    ).toMatchObject({ state: "limited", remainingSteps: null });
  });
});
