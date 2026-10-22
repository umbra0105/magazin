import { describe, expect, it } from "vitest";
import {
  QuantityError,
  formatQuantity,
  parseQuantity,
  parseSignedDelta,
  quantityFromTicks,
  type Quantity,
} from "@ecom/shared";
import { computeAvailability, type AvailabilityInput } from "./availability";
import {
  mirrorDecision,
  reconcileSnapshot,
  snapshotFreshness,
  type CommitmentInput,
} from "./reconcile";

const q = (text: string): Quantity => parseQuantity(text);
const fmt = (value: Quantity): string => formatQuantity(value);
const at = (hhmm: string, ms = 0): Date => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return new Date(Date.UTC(2026, 9, 21, Number(h), Number(m), 0, ms));
};

function available(physical: Quantity, committed: Quantity, step = "1"): bigint | null {
  const input: AvailabilityInput = {
    isDigital: false,
    manageStock: true,
    stockStatus: "instock",
    allowBackorder: false,
    step: q(step),
    inventory: { physical, committed, reserved: q("0"), safetyBuffer: q("0"), lowStockSteps: null },
    defaultLowStockSteps: 2,
    leadTime: { productDays: null, brandDays: null, globalDays: 14 },
  };
  return computeAvailability(input).availableSteps;
}

describe("factura față de poză: oglindită sau încă angajată (fereastra de siguranță)", () => {
  const photo = at("12:00");

  it.each([
    ["cu 2 ore înainte de poză", at("10:01"), 30, "mirrored"],
    ["exact la marginea ferestrei (12:00 − 30 min)", at("11:30"), 30, "mirrored"],
    ["la 1 ms înăuntrul ferestrei", at("11:30", 1), 30, "committed"],
    ["cu 1 minut înainte de poză, în fereastră", at("11:59"), 30, "committed"],
    ["exact la ora pozei, în fereastră", at("12:00"), 30, "committed"],
    ["după poză", at("12:01"), 30, "committed"],
    ["după poză, departe", at("15:00"), 30, "committed"],
    ["fără factură", null, 30, "committed"],
    ["fereastra 0: exact la ora pozei = oglindită", at("12:00"), 0, "mirrored"],
    ["fereastra 0: cu 1 ms înainte = oglindită", at("11:59", 999), 0, "mirrored"],
    ["fereastra 0: cu 1 ms după = angajată", at("12:00", 1), 0, "committed"],
    [
      "fereastră mare (24 h): factura de ieri la 13:00 (23 h înainte) = încă angajată",
      new Date(Date.UTC(2026, 9, 20, 13, 0)),
      1440,
      "committed",
    ],
    [
      "fereastră mare (24 h): factura de ieri la 11:00 (25 h înainte) = oglindită",
      new Date(Date.UTC(2026, 9, 20, 11, 0)),
      1440,
      "mirrored",
    ],
    [
      "fereastră mare (24 h): marginea exactă",
      new Date(Date.UTC(2026, 9, 20, 12, 0)),
      1440,
      "mirrored",
    ],
  ])("%s", (_name, invoicedAt, windowMinutes, expected) => {
    expect(mirrorDecision(invoicedAt, photo, windowMinutes)).toBe(expected);
  });

  it("fereastra invalidă sau date invalide se refuză", () => {
    for (const bad of [-1, 1.5, Number.NaN, 1441]) {
      expect(() => mirrorDecision(at("10:00"), photo, bad), String(bad)).toThrow(RangeError);
    }
    expect(() => mirrorDecision(new Date("nu e dată"), photo, 30)).toThrow(RangeError);
    expect(() => mirrorDecision(at("10:00"), new Date("nu e dată"), 30)).toThrow(RangeError);
  });
});

describe("cronologia din plan: o bucată se scade o singură dată", () => {
  // 09:00 poză 5 · 10:00 comandă online 1 buc · 10:01 factură (SmartBill: 4) · 11:00 vânzare în magazin (SmartBill: 3)
  const order: CommitmentInput = { id: "comanda-1", quantity: q("1"), invoicedAt: at("10:01") };

  it("poza de la 12:00 (SmartBill 3) conține deja factura: comanda încetează să mai fie angajată", () => {
    const result = reconcileSnapshot({
      snapshot: { quantity: q("3"), takenAt: at("12:00") },
      safetyWindowMinutes: 30,
      commitments: [order],
      adjustments: [],
    });
    expect(result).toMatchObject({ mirroredIds: ["comanda-1"], stillCommittedIds: [] });
    expect(fmt(result.physical)).toBe("3");
    expect(fmt(result.committed)).toBe("0");
    // 3, nu 3 − 1 = 2 (scădere dublă)
    expect(available(result.physical, result.committed)).toBe(3n);
  });

  it("între 10:01 și 11:00 (poza veche de la 09:00), comanda e încă angajată: 5 − 1 = 4", () => {
    const result = reconcileSnapshot({
      snapshot: { quantity: q("5"), takenAt: at("09:00") },
      safetyWindowMinutes: 30,
      commitments: [order],
      adjustments: [],
    });
    expect(result.stillCommittedIds).toEqual(["comanda-1"]);
    expect(available(result.physical, result.committed)).toBe(4n);
  });

  it("poza de la 10:20 (SmartBill 4) cu factura de la 10:01: în fereastra de 30 min rămâne angajată (subvânzare cu 1, nu supravânzare)", () => {
    const result = reconcileSnapshot({
      snapshot: { quantity: q("4"), takenAt: at("10:20") },
      safetyWindowMinutes: 30,
      commitments: [order],
      adjustments: [],
    });
    expect(result.stillCommittedIds).toEqual(["comanda-1"]);
    expect(available(result.physical, result.committed)).toBe(3n); // adevărul e 4
    // cu fereastra 0, aceeași poză dă adevărul
    const exact = reconcileSnapshot({
      snapshot: { quantity: q("4"), takenAt: at("10:20") },
      safetyWindowMinutes: 0,
      commitments: [order],
      adjustments: [],
    });
    expect(available(exact.physical, exact.committed)).toBe(4n);
  });

  it("comanda fără factură (SmartBill n-a răspuns) rămâne angajată, oricât de veche e poza", () => {
    const result = reconcileSnapshot({
      snapshot: { quantity: q("5"), takenAt: at("23:00") },
      safetyWindowMinutes: 30,
      commitments: [{ id: "fara-factura", quantity: q("2"), invoicedAt: null }],
      adjustments: [],
    });
    expect(result.stillCommittedIds).toEqual(["fara-factura"]);
    expect(fmt(result.committed)).toBe("2");
  });

  it("comanda facturată după poză rămâne angajată (poza nu o conține)", () => {
    const result = reconcileSnapshot({
      snapshot: { quantity: q("5"), takenAt: at("09:00") },
      safetyWindowMinutes: 30,
      commitments: [{ id: "tarziu", quantity: q("1"), invoicedAt: at("09:45") }],
      adjustments: [],
    });
    expect(result.stillCommittedIds).toEqual(["tarziu"]);
  });

  it("repetarea aceleiași poze dă același rezultat (funcție pură, idempotentă)", () => {
    const input = {
      snapshot: { quantity: q("3"), takenAt: at("12:00") },
      safetyWindowMinutes: 30,
      commitments: [order, { id: "b", quantity: q("2"), invoicedAt: null }],
      adjustments: [],
    };
    expect(reconcileSnapshot(input)).toEqual(reconcileSnapshot(input));
  });
});

describe("ajustările cu ora efectivă: poza le înlocuiește pe cele dinainte", () => {
  const photo = { quantity: q("10"), takenAt: at("12:00") };
  const base = { snapshot: photo, safetyWindowMinutes: 30, commitments: [] as CommitmentInput[] };

  it("cele de după poză rămân aplicate; cele dinainte și de la ora exactă a pozei dispar", () => {
    const result = reconcileSnapshot({
      ...base,
      adjustments: [
        { effectiveAt: at("11:00"), delta: parseSignedDelta("-1") }, // vânzare în magazin ÎNAINTE de poză: deja în SmartBill
        { effectiveAt: at("12:00"), delta: parseSignedDelta("-2") }, // exact la ora pozei: deja în poză
        { effectiveAt: at("12:00", 1), delta: parseSignedDelta("-3") }, // după poză: rămâne
        { effectiveAt: at("14:00"), delta: parseSignedDelta("0,5") }, // recepție după poză: rămâne
      ],
    });
    expect(fmt(result.physical)).toBe("7,5"); // 10 − 3 + 0,5
    expect(result).toMatchObject({
      keptAdjustments: 2,
      droppedAdjustments: 2,
      physicalClamped: false,
    });
  });

  it("fără ajustări, fizicul e poza", () => {
    const result = reconcileSnapshot({ ...base, adjustments: [] });
    expect(fmt(result.physical)).toBe("10");
    expect(result).toMatchObject({ keptAdjustments: 0, droppedAdjustments: 0 });
  });

  it("ajustările de după poză care ar duce sub zero: fizicul rămâne 0 (fără stoc negativ), cu semnal", () => {
    const result = reconcileSnapshot({
      ...base,
      adjustments: [{ effectiveAt: at("13:00"), delta: parseSignedDelta("-12") }],
    });
    expect(fmt(result.physical)).toBe("0");
    expect(result.physicalClamped).toBe(true);
  });

  it("peste plafon se refuză, nu se taie", () => {
    expect(() =>
      reconcileSnapshot({
        snapshot: { quantity: quantityFromTicks(1_000_000_000_000n), takenAt: at("12:00") },
        safetyWindowMinutes: 30,
        commitments: [],
        adjustments: [{ effectiveAt: at("13:00"), delta: parseSignedDelta("1") }],
      }),
    ).toThrow(QuantityError);
  });

  it("cu zecimale exacte: 3 comenzi de câte 0,3 pe o poză de 1,0", () => {
    const result = reconcileSnapshot({
      snapshot: { quantity: q("1"), takenAt: at("12:00") },
      safetyWindowMinutes: 30,
      commitments: [
        { id: "a", quantity: q("0,3"), invoicedAt: at("09:00") }, // oglindită
        { id: "b", quantity: q("0,3"), invoicedAt: null }, // angajată
        { id: "c", quantity: q("0,3"), invoicedAt: at("12:10") }, // angajată
      ],
      adjustments: [],
    });
    expect(result.mirroredIds).toEqual(["a"]);
    expect(result.stillCommittedIds).toEqual(["b", "c"]);
    expect(fmt(result.committed)).toBe("0,6");
    // disponibil 1,0 − 0,6 = 0,4 → 1 pas de 0,3, rest 0,1
    expect(available(result.physical, result.committed, "0,3")).toBe(1n);
  });
});

describe("simulare: oricare ar fi cronologia, aplicația nu vinde niciodată de două ori", () => {
  // Modelul de adevăr, independent: ce are SmartBill la ora pozei și ce comenzi nu sunt încă în el.
  interface Order {
    id: string;
    qty: number; // zecimi de miime
    confirmedAt: number; // minute
    invoicedAt: number | null;
  }

  function simulate(seed: number) {
    let state = seed;
    const rnd = () => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return state / 4_294_967_296;
    };
    const minutes = (m: number): Date => new Date(Date.UTC(2026, 9, 21) + m * 60_000);
    const photoAt = Math.floor(rnd() * 600) + 60;
    const windowMinutes = [0, 15, 30, 60][Math.floor(rnd() * 4)] ?? 30;
    const orders: Order[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => {
      const confirmedAt = Math.floor(rnd() * photoAt);
      return {
        id: `o${i}`,
        qty: (1 + Math.floor(rnd() * 5)) * 3_000, // multipli de 0,3
        confirmedAt,
        invoicedAt: rnd() < 0.2 ? null : confirmedAt + Math.floor(rnd() * 120),
      };
    });
    const storeSales = Array.from({ length: Math.floor(rnd() * 5) }, () => ({
      at: Math.floor(rnd() * 700),
      qty: (1 + Math.floor(rnd() * 3)) * 3_000,
    }));
    const initial = 5_000_000;
    // SmartBill la ora pozei: scade facturile și vânzările din magazin până atunci
    const smartbillAtPhoto =
      initial -
      orders
        .filter((o) => o.invoicedAt !== null && o.invoicedAt <= photoAt)
        .reduce((n, o) => n + o.qty, 0) -
      storeSales.filter((s) => s.at <= photoAt).reduce((n, s) => n + s.qty, 0);
    // adevărul: comenzile confirmate dar încă nefacturate la ora pozei nu sunt libere
    const trulyUninvoiced = orders
      .filter((o) => o.invoicedAt === null || o.invoicedAt > photoAt)
      .reduce((n, o) => n + o.qty, 0);
    const trueAvailable = smartbillAtPhoto - trulyUninvoiced;
    // ce suntem obligați să păstrăm prudent: facturate în (poză − fereastră, poză]
    const insideWindow = orders
      .filter(
        (o) =>
          o.invoicedAt !== null &&
          o.invoicedAt > photoAt - windowMinutes &&
          o.invoicedAt <= photoAt,
      )
      .reduce((n, o) => n + o.qty, 0);

    const result = reconcileSnapshot({
      snapshot: { quantity: quantityFromTicks(smartbillAtPhoto), takenAt: minutes(photoAt) },
      safetyWindowMinutes: windowMinutes,
      commitments: orders.map((o) => ({
        id: o.id,
        quantity: quantityFromTicks(o.qty),
        invoicedAt: o.invoicedAt === null ? null : minutes(o.invoicedAt),
      })),
      adjustments: [],
    });
    const appAvailable = Number(result.physical) - Number(result.committed);
    const allOrdersQty = orders.reduce((n, o) => n + o.qty, 0);
    const invoicedByPhoto = orders
      .filter((o) => o.invoicedAt !== null && o.invoicedAt <= photoAt)
      .reduce((n, o) => n + o.qty, 0);
    return {
      appAvailable,
      trueAvailable,
      insideWindow,
      smartbillAtPhoto,
      allOrdersQty,
      invoicedByPhoto,
    };
  }

  it("niciodată supravânzare, iar subvânzarea e exact cât s-a facturat în fereastra pozei (700 de cronologii)", () => {
    let withDifference = 0;
    for (let seed = 1; seed <= 700; seed++) {
      const s = simulate(seed);
      expect(s.appAvailable, `seed ${seed}: supravânzare`).toBeLessThanOrEqual(s.trueAvailable);
      expect(s.trueAvailable - s.appAvailable, `seed ${seed}: subvânzare`).toBe(s.insideWindow);
      if (s.insideWindow > 0) withDifference++;
    }
    // simularea chiar a acoperit și cazurile cu factură în fereastră
    expect(withDifference).toBeGreaterThan(30);
  });

  it("modelul naiv (poza minus TOATE comenzile) scade de două ori ce SmartBill a scăzut deja; regula noastră nu", () => {
    let doubleSubtracted = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = simulate(seed);
      const naive = s.smartbillAtPhoto - s.allOrdersQty;
      // naivul scade în plus exact ce e deja în poză (facturat până la poză)
      expect(s.trueAvailable - naive, `seed ${seed}`).toBe(s.invoicedByPhoto);
      // regula noastră greșește (în prudență) cel mult cât s-a facturat în fereastră, niciodată cât tot ce e în poză
      expect(s.trueAvailable - s.appAvailable).toBeLessThanOrEqual(s.trueAvailable - naive);
      if (s.invoicedByPhoto > 0) doubleSubtracted++;
    }
    expect(doubleSubtracted).toBeGreaterThan(100);
  });
});

describe("poza veche: avertisment după un număr de ore", () => {
  const now = new Date(Date.UTC(2026, 9, 21, 12, 0));
  const ago = (hours: number, extraMs = 0): Date =>
    new Date(now.getTime() - hours * 3_600_000 - extraMs);

  it("fără nicio poză: «never»", () => {
    expect(snapshotFreshness(null, now, 24)).toEqual({ status: "never" });
  });

  it("proaspătă până la limita exactă; veche abia după", () => {
    expect(snapshotFreshness(ago(1), now, 24)).toEqual({ status: "fresh", ageHours: 1 });
    expect(snapshotFreshness(ago(23.5), now, 24)).toMatchObject({ status: "fresh" });
    expect(snapshotFreshness(ago(24), now, 24)).toMatchObject({ status: "fresh", ageHours: 24 });
    expect(snapshotFreshness(ago(24, 1), now, 24)).toMatchObject({ status: "stale" });
    expect(snapshotFreshness(ago(72), now, 24)).toMatchObject({ status: "stale", ageHours: 72 });
  });

  it("ceasul rămas în urmă (poză «din viitor»): proaspătă, vârsta 0", () => {
    expect(snapshotFreshness(new Date(now.getTime() + 5 * 60_000), now, 24)).toEqual({
      status: "fresh",
      ageHours: 0,
    });
  });

  it("pragul se citește din setare: 1–720 de ore, întreg", () => {
    expect(snapshotFreshness(ago(2), now, 1)).toMatchObject({ status: "stale" });
    for (const bad of [0, -1, 1.5, 721, Number.NaN]) {
      expect(() => snapshotFreshness(ago(1), now, bad), String(bad)).toThrow(RangeError);
    }
  });
});
