import { describe, expect, it } from "vitest";
import { formatQuantity, parseQuantity, quantityFromTicks, type Quantity } from "@ecom/shared";
import { Fraction, stepsBySubtraction } from "../test-utils/fraction";
import {
  checkOrderable,
  computeAvailability,
  longestLeadTime,
  resolveLeadTimeDays,
  type AvailabilityInput,
  type StockStatusValue,
} from "./availability";

const q = (text: string): Quantity => parseQuantity(text);
const fmt = (value: Quantity | null): string | null =>
  value === null ? null : formatQuantity(value);

interface ManagedCase {
  step?: string;
  physical?: string;
  committed?: string;
  reserved?: string;
  buffer?: string;
  lowStockSteps?: number | null;
  minSteps?: number | null;
  allowBackorder?: boolean;
  defaultLowStockSteps?: number;
  leadTime?: { productDays: number | null; brandDays: number | null; globalDays: number };
}

function managed(c: ManagedCase = {}): AvailabilityInput {
  return {
    isDigital: false,
    manageStock: true,
    stockStatus: "instock",
    allowBackorder: c.allowBackorder ?? false,
    step: q(c.step ?? "1"),
    minSteps: c.minSteps ?? null,
    inventory: {
      physical: q(c.physical ?? "0"),
      committed: q(c.committed ?? "0"),
      reserved: q(c.reserved ?? "0"),
      safetyBuffer: q(c.buffer ?? "0"),
      lowStockSteps: c.lowStockSteps ?? null,
    },
    defaultLowStockSteps: c.defaultLowStockSteps ?? 2,
    leadTime: c.leadTime ?? { productDays: null, brandDays: null, globalDays: 14 },
  };
}

function unmanaged(
  stockStatus: StockStatusValue,
  over: Partial<AvailabilityInput> = {},
): AvailabilityInput {
  return { ...managed(), manageStock: false, stockStatus, inventory: null, ...over };
}

describe("ramura gestionată: disponibil, pași și rest (tabel de stări calculat de mână)", () => {
  // [descriere, caz, stare, pași, rest, comandabil de client (nul = fără limită)]
  const rows: Array<[string, ManagedCase, string, bigint, string, bigint | null]> = [
    ["5 buc, mult peste prag", { physical: "5" }, "in_stock", 5n, "0", 5n],
    ["2 buc = exact pragul: stoc limitat", { physical: "2" }, "limited", 2n, "0", 2n],
    ["1 buc: stoc limitat", { physical: "1" }, "limited", 1n, "0", 1n],
    ["0 buc: indisponibil", { physical: "0" }, "unavailable", 0n, "0", 0n],
    [
      "liner: 100 mp, rola de 41,25 → 2 pași, rest 17,5",
      { step: "41,25", physical: "100" },
      "limited",
      2n,
      "17,5",
      2n,
    ],
    [
      "liner: 123,75 mp → 3 pași, în stoc",
      { step: "41,25", physical: "123,75" },
      "in_stock",
      3n,
      "0",
      3n,
    ],
    [
      "liner: 82,5 mp → exact 2 pași, fără rest",
      { step: "41,25", physical: "82,5" },
      "limited",
      2n,
      "0",
      2n,
    ],
    [
      "liner: 41,24 mp → sub un pas: doar rest",
      { step: "41,25", physical: "41,24" },
      "unavailable",
      0n,
      "41,24",
      0n,
    ],
    [
      "mozaic: 10 mp, cutia de 2,03 → 4 cutii, rest 1,88",
      { step: "2,03", physical: "10" },
      "in_stock",
      4n,
      "1,88",
      4n,
    ],
    [
      "țeavă: 17,5 ml, pas 2,5 → 7 pași exact",
      { step: "2,5", physical: "17,5" },
      "in_stock",
      7n,
      "0",
      7n,
    ],
    [
      "bisulfat: 80 kg, sacul de 25 → 3 saci, rest 5",
      { step: "25", physical: "80" },
      "in_stock",
      3n,
      "5",
      3n,
    ],
    [
      "abachi: 1,0 ml pe pas 0,3 → 3 pași, rest 0,1 (10 × 0,3 pe 1,0)",
      { step: "0,3", physical: "1" },
      "in_stock",
      3n,
      "0,1",
      3n,
    ],
    [
      "angajat și rezervat se scad",
      { physical: "5", committed: "2", reserved: "1" },
      "limited",
      2n,
      "0",
      2n,
    ],
    [
      "angajat peste fizic: niciodată sub zero",
      { physical: "3", committed: "5" },
      "unavailable",
      0n,
      "0",
      0n,
    ],
    [
      "rezervat peste fizic: niciodată sub zero",
      { physical: "1", reserved: "4" },
      "unavailable",
      0n,
      "0",
      0n,
    ],
    ["tampon 3 din 5 → 2 vandabile", { physical: "5", buffer: "3" }, "limited", 2n, "0", 2n],
    [
      "tampon egal cu stocul → indisponibil",
      { physical: "5", buffer: "5" },
      "unavailable",
      0n,
      "0",
      0n,
    ],
    [
      "tampon peste stoc → indisponibil, nu negativ",
      { physical: "2", buffer: "9" },
      "unavailable",
      0n,
      "0",
      0n,
    ],
    [
      "tamponul se aplică după angajat/rezervat",
      { physical: "10", committed: "3", reserved: "2", buffer: "1" },
      "in_stock",
      4n,
      "0",
      4n,
    ],
    [
      "prag propriu 0: niciodată «limitat»",
      { physical: "1", lowStockSteps: 0 },
      "in_stock",
      1n,
      "0",
      1n,
    ],
    [
      "prag propriu 5: 5 pași = limitat",
      { physical: "5", lowStockSteps: 5 },
      "limited",
      5n,
      "0",
      5n,
    ],
    [
      "pragul global schimbat la 4",
      { physical: "4", defaultLowStockSteps: 4 },
      "limited",
      4n,
      "0",
      4n,
    ],
    [
      "pragul propriu bate pe cel global",
      { physical: "4", defaultLowStockSteps: 4, lowStockSteps: 1 },
      "in_stock",
      4n,
      "0",
      4n,
    ],
    [
      "minim 2 pași, doar 1 → nu se poate comanda",
      { physical: "1", minSteps: 2 },
      "unavailable",
      1n,
      "0",
      0n,
    ],
    ["minim 2 pași, exact 2 → se poate", { physical: "2", minSteps: 2 }, "limited", 2n, "0", 2n],
    ["minim 3 pași, 10 → în stoc", { physical: "10", minSteps: 3 }, "in_stock", 10n, "0", 10n],
  ];

  it.each(rows)("%s", (_name, c, state, steps, rest, orderable) => {
    const a = computeAvailability(managed(c));
    expect(a.branch).toBe("managed");
    expect(a.state).toBe(state);
    expect(a.availableSteps).toBe(steps);
    expect(fmt(a.remainder)).toBe(rest);
    expect(a.orderableSteps).toBe(orderable);
    expect(a.purchasable).toBe(state !== "unavailable");
    expect(a.leadTimeDays).toBeNull();
  });

  it("«Stoc limitat» arată câți mai sunt (în pași); celelalte stări nu arată numărul", () => {
    expect(computeAvailability(managed({ physical: "2" })).showCount).toBe(2n);
    expect(computeAvailability(managed({ step: "41,25", physical: "100" })).showCount).toBe(2n);
    expect(computeAvailability(managed({ physical: "9" })).showCount).toBeNull();
    expect(computeAvailability(managed({ physical: "0" })).showCount).toBeNull();
  });

  it("valorile de administrare: disponibil, vandabil (după tampon), pași, rest, alertă de stoc mic", () => {
    const a = computeAvailability(
      managed({ step: "41,25", physical: "100", committed: "10", reserved: "5", buffer: "2" }),
    );
    expect(fmt(a.available)).toBe("85"); // 100 − 10 − 5
    expect(fmt(a.sellable)).toBe("83"); // − tampon 2
    expect(a.availableSteps).toBe(2n); // 83 / 41,25
    expect(fmt(a.remainder)).toBe("0,5"); // 83 − 82,5
    expect(a.lowStock).toBe(true); // 2 pași ≤ prag 2
    const stocked = computeAvailability(managed({ physical: "50" }));
    expect(stocked.lowStock).toBe(false);
  });

  it("alerta de stoc mic: la prag sau sub el, inclusiv la zero; cu pragul 0 doar la epuizare", () => {
    expect(computeAvailability(managed({ physical: "2" })).lowStock).toBe(true);
    expect(computeAvailability(managed({ physical: "0" })).lowStock).toBe(true);
    expect(computeAvailability(managed({ physical: "3" })).lowStock).toBe(false);
    expect(computeAvailability(managed({ physical: "1", lowStockSteps: 0 })).lowStock).toBe(false);
    expect(computeAvailability(managed({ physical: "0", lowStockSteps: 0 })).lowStock).toBe(true);
  });

  it("«rest nevandabil»: marcat doar când restul e tot ce a mai rămas", () => {
    expect(computeAvailability(managed({ step: "41,25", physical: "17,5" })).remainderOnly).toBe(
      true,
    );
    expect(computeAvailability(managed({ step: "41,25", physical: "100" })).remainderOnly).toBe(
      false,
    );
    expect(computeAvailability(managed({ step: "41,25", physical: "0" })).remainderOnly).toBe(
      false,
    );
    expect(computeAvailability(managed({ step: "41,25", physical: "82,5" })).remainderOnly).toBe(
      false,
    );
  });

  it("fără rând de stoc (încă neinventariat), un produs gestionat e indisponibil", () => {
    const a = computeAvailability({ ...managed(), inventory: null });
    expect(a).toMatchObject({
      state: "unavailable",
      purchasable: false,
      availableSteps: 0n,
      orderableSteps: 0n,
    });
    expect(fmt(a.available)).toBe("0");
  });
});

describe("hibridul: gestionat care se epuizează devine «La comandă» doar cu allowBackorder", () => {
  it("epuizat, fără hibrid: indisponibil; cu hibrid: la comandă, fără limită de cantitate", () => {
    expect(computeAvailability(managed({ physical: "0" })).state).toBe("unavailable");
    const hybrid = computeAvailability(managed({ physical: "0", allowBackorder: true }));
    expect(hybrid).toMatchObject({
      state: "on_order",
      purchasable: true,
      orderableSteps: null,
      leadTimeDays: 14,
      showCount: null,
    });
  });

  it("cât există stoc, hibridul vinde din stoc (și NU depășește stocul)", () => {
    const a = computeAvailability(managed({ physical: "5", allowBackorder: true }));
    expect(a).toMatchObject({ state: "in_stock", orderableSteps: 5n, leadTimeDays: null });
    const limited = computeAvailability(managed({ physical: "2", allowBackorder: true }));
    expect(limited).toMatchObject({ state: "limited", orderableSteps: 2n });
  });

  it("sub minim, hibridul trece la «La comandă»", () => {
    const a = computeAvailability(managed({ physical: "1", minSteps: 2, allowBackorder: true }));
    expect(a).toMatchObject({ state: "on_order", orderableSteps: null });
  });

  it("doar un rest nevandabil + hibrid: la comandă", () => {
    const a = computeAvailability(
      managed({ step: "41,25", physical: "17,5", allowBackorder: true }),
    );
    expect(a).toMatchObject({ state: "on_order", remainderOnly: true });
  });
});

describe("ramura negestionată: doar starea aleasă, fără cantități", () => {
  it("în stoc / epuizat / la comandă", () => {
    expect(computeAvailability(unmanaged("instock"))).toMatchObject({
      branch: "unmanaged",
      state: "in_stock",
      purchasable: true,
      orderableSteps: null,
      available: null,
      availableSteps: null,
      remainder: null,
      lowStock: false,
      leadTimeDays: null,
    });
    expect(computeAvailability(unmanaged("outofstock"))).toMatchObject({
      state: "unavailable",
      purchasable: false,
      orderableSteps: 0n,
    });
    expect(computeAvailability(unmanaged("onbackorder"))).toMatchObject({
      state: "on_order",
      purchasable: true,
      orderableSteps: null,
      leadTimeDays: 14,
    });
  });

  it("ignoră complet inventarul și `allowBackorder` (nu simulează cu cantități)", () => {
    const withStock = unmanaged("instock", { inventory: managed({ physical: "0" }).inventory });
    expect(computeAvailability(withStock).state).toBe("in_stock");
    const outWithStock = unmanaged("outofstock", {
      inventory: managed({ physical: "99" }).inventory,
    });
    expect(computeAvailability(outWithStock).state).toBe("unavailable");
    expect(computeAvailability(unmanaged("outofstock", { allowBackorder: true })).state).toBe(
      "unavailable",
    );
  });
});

describe("produsele digitale: mereu disponibile", () => {
  it("indiferent de gestiune, stare sau stoc", () => {
    for (const input of [
      { ...managed({ physical: "0" }), isDigital: true },
      { ...unmanaged("outofstock"), isDigital: true },
      { ...unmanaged("onbackorder"), isDigital: true },
    ]) {
      expect(computeAvailability(input)).toMatchObject({
        branch: "digital",
        state: "in_stock",
        purchasable: true,
        orderableSteps: null,
        leadTimeDays: null,
        lowStock: false,
      });
    }
  });
});

describe("termenul «La comandă»: produs → brand → global", () => {
  it("prima valoare setată; 0 zile e o valoare, nu «lipsă»", () => {
    expect(resolveLeadTimeDays({ productDays: 7, brandDays: 10, globalDays: 14 })).toBe(7);
    expect(resolveLeadTimeDays({ productDays: null, brandDays: 10, globalDays: 14 })).toBe(10);
    expect(resolveLeadTimeDays({ productDays: null, brandDays: null, globalDays: 14 })).toBe(14);
    expect(resolveLeadTimeDays({ productDays: 0, brandDays: 10, globalDays: 14 })).toBe(0);
    expect(resolveLeadTimeDays({ productDays: null, brandDays: 0, globalDays: 14 })).toBe(0);
  });

  it("intră în starea «La comandă» (ramura negestionată și hibridul)", () => {
    const leadTime = { productDays: null, brandDays: 21, globalDays: 14 };
    expect(computeAvailability(unmanaged("onbackorder", { leadTime })).leadTimeDays).toBe(21);
    expect(
      computeAvailability(managed({ physical: "0", allowBackorder: true, leadTime })).leadTimeDays,
    ).toBe(21);
    expect(
      computeAvailability(unmanaged("onbackorder", { leadTime: { ...leadTime, productDays: 3 } }))
        .leadTimeDays,
    ).toBe(3);
  });

  it("termen invalid (negativ, fracționar, peste 365) se refuză", () => {
    for (const bad of [-1, 1.5, 366, Number.NaN]) {
      expect(
        () => resolveLeadTimeDays({ productDays: bad, brandDays: null, globalDays: 14 }),
        String(bad),
      ).toThrow(RangeError);
    }
    expect(() =>
      resolveLeadTimeDays({ productDays: null, brandDays: null, globalDays: -1 }),
    ).toThrow(RangeError);
  });

  it("cel mai lung termen dintr-un coș mixt și produsul care îl cauzează", () => {
    expect(longestLeadTime([])).toBeNull();
    expect(
      longestLeadTime([
        { key: "pompa", leadTimeDays: 14 },
        { key: "filtru", leadTimeDays: 21 },
        { key: "furtun", leadTimeDays: 3 },
      ]),
    ).toEqual({ days: 21, key: "filtru" });
    // la egalitate, primul din coș
    expect(
      longestLeadTime([
        { key: "a", leadTimeDays: 7 },
        { key: "b", leadTimeDays: 7 },
      ]),
    ).toEqual({ days: 7, key: "a" });
  });
});

describe("cât se poate comanda (verificat înainte de rezervare)", () => {
  it("gestionat: până la pașii disponibili; peste = refuz cu maximul", () => {
    const a = computeAvailability(managed({ step: "41,25", physical: "100" }));
    expect(checkOrderable(a, 1n)).toEqual({ ok: true });
    expect(checkOrderable(a, 2n)).toEqual({ ok: true });
    expect(checkOrderable(a, 3n)).toEqual({ ok: false, reason: "exceeds_available", maxSteps: 2n });
  });

  it("indisponibil: refuz; la comandă, negestionat în stoc și digital: fără limită", () => {
    expect(checkOrderable(computeAvailability(managed({ physical: "0" })), 1n)).toEqual({
      ok: false,
      reason: "unavailable",
      maxSteps: 0n,
    });
    expect(
      checkOrderable(computeAvailability(managed({ physical: "1", minSteps: 2 })), 1n),
    ).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    for (const input of [
      managed({ physical: "0", allowBackorder: true }),
      unmanaged("instock"),
      unmanaged("onbackorder"),
      { ...managed({ physical: "0" }), isDigital: true },
    ]) {
      expect(checkOrderable(computeAvailability(input), 1_000_000n)).toEqual({ ok: true });
    }
  });

  it("pași zero sau negativi se refuză", () => {
    const a = computeAvailability(managed({ physical: "5" }));
    expect(() => checkOrderable(a, 0n)).toThrow(RangeError);
    expect(() => checkOrderable(a, -1n)).toThrow(RangeError);
  });
});

describe("față de calculul de referință (fracții exacte, scădere repetată)", () => {
  it("pași și rest pe 600 de cazuri aleatorii (zecimale, tampon, angajat, rezervat)", () => {
    let seed = 20261024;
    const rnd = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const text = (ticks: number): string => formatQuantity(quantityFromTicks(ticks));
    for (let i = 0; i < 600; i++) {
      const step = 1 + Math.floor(rnd() * 5_000); // până la 0,5 unități
      const physical = Math.floor(rnd() * step * 120);
      const committed = Math.floor(rnd() * physical * 0.4);
      const reserved = Math.floor(rnd() * physical * 0.3);
      const buffer = Math.floor(rnd() * step * 3);
      const a = computeAvailability(
        managed({
          step: formatQuantity(quantityFromTicks(step)),
          physical: text(physical),
          committed: text(committed),
          reserved: text(reserved),
          buffer: text(buffer),
        }),
      );
      const sellable = Fraction.of(text(physical))
        .minus(Fraction.of(text(committed)))
        .minus(Fraction.of(text(reserved)))
        .minus(Fraction.of(text(buffer)))
        .atLeastZero();
      const reference = stepsBySubtraction(
        sellable,
        Fraction.of(formatQuantity(quantityFromTicks(step))),
      );
      expect(a.availableSteps, `${physical}/${committed}/${reserved}/${buffer}/${step}`).toBe(
        BigInt(reference.steps),
      );
      expect(fmt(a.remainder)).toBe(reference.rest.toDecimalText());
      expect(fmt(a.sellable)).toBe(sellable.toDecimalText());
    }
  });
});
