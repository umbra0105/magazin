import { describe, expect, it } from "vitest";
import { vatFromGross } from "@ecom/shared";
import {
  buildPartialStorno,
  buildRemainderStorno,
  collapseInexactLines,
  type StornoEarlierLine,
  type StornoParentLine,
  type StornoReturned,
  type StornoSourceLine,
} from "./invoice-draft";

/**
 * Restul nestornat al unei facturi (mini-faza `storno-total`): funcție PURĂ. Brutul tuturor stornourilor = totalul facturii EXACT
 * (ultima bucată ia restul); TVA-ul restului se extrage din brutul restului (ca la orice storno), deci suma TVA poate diferi de TVA-ul
 * liniei originale cu cel mult 1 ban pe linie atinsă de stornouri în bucăți (decizia 2026-11-23; de confirmat cu contabilul).
 */
const product = (
  id: string,
  unitPriceMinor: number,
  quantityTicks: bigint,
  lineTotalMinor: number,
): StornoParentLine => {
  const taxMinor = vatFromGross(lineTotalMinor, 2100);
  return {
    kind: "product",
    orderLineId: id,
    sku: `SKU-${id}`,
    title: `Produs ${id}`,
    unitName: "buc",
    quantityTicks,
    unitPriceMinor,
    lineTotalMinor,
    netMinor: lineTotalMinor - taxMinor,
    taxMinor,
    taxRateBps: 2100,
  };
};

const service = (
  kind: "shipping" | "cod_fee",
  grossMinor: number,
  taxMinor = vatFromGross(grossMinor, 2100),
): StornoParentLine => ({
  kind,
  orderLineId: null,
  sku: null,
  title: kind === "shipping" ? "Transport" : "Taxă ramburs",
  unitName: "serviciu",
  quantityTicks: 10_000n,
  unitPriceMinor: grossMinor,
  lineTotalMinor: grossMinor,
  netMinor: grossMinor - taxMinor,
  taxMinor,
  taxRateBps: 2100,
});

/** Un storno parțial construit cu aceeași funcție ca în producție, transformat în liniile «anterioare». */
function partial(
  parent: readonly StornoParentLine[],
  earlier: readonly StornoEarlierLine[],
  requested: Array<{ orderLineId: string; quantityTicks: bigint }>,
): StornoEarlierLine[] {
  const source: StornoSourceLine[] = parent
    .filter((l) => l.kind === "product")
    .map((l) => ({
      orderLineId: l.orderLineId as string,
      sku: l.sku as string,
      title: l.title,
      unitName: l.unitName,
      quantityTicks: l.quantityTicks,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
      taxMinor: l.taxMinor,
      taxRateBps: l.taxRateBps,
    }));
  const returned = new Map<string, StornoReturned>();
  for (const e of earlier) {
    if (!e.orderLineId) continue;
    const prev = returned.get(e.orderLineId) ?? {
      quantityTicks: 0n,
      lineTotalMinor: 0,
      taxMinor: 0,
    };
    returned.set(e.orderLineId, {
      quantityTicks: prev.quantityTicks + e.quantityTicks,
      lineTotalMinor: prev.lineTotalMinor + e.lineTotalMinor,
      taxMinor: prev.taxMinor + e.taxMinor,
    });
  }
  const built = buildPartialStorno(source, returned, requested);
  return [
    ...earlier,
    ...built.lines.map((l) => ({
      kind: l.kind,
      orderLineId: l.orderLineId,
      quantityTicks: l.quantityTicks,
      lineTotalMinor: l.lineTotalMinor,
      taxMinor: l.taxMinor,
    })),
  ];
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const earlierTotal = (earlier: readonly StornoEarlierLine[]) =>
  sum(earlier.map((e) => e.lineTotalMinor));

describe("buildRemainderStorno: restul nestornat al facturii", () => {
  it("scenariul 1000 lei: 400 stornat, restul e 600 și totalul stornat e 1000 (nu 1400)", () => {
    const parent = [product("a", 50_000, 20_000n, 100_000)];
    const earlier = partial(parent, [], [{ orderLineId: "a", quantityTicks: 8_000n }]);
    expect(earlierTotal(earlier)).toBe(40_000);
    const rest = buildRemainderStorno(parent, earlier);
    expect(rest.totalMinor).toBe(60_000);
    expect(earlierTotal(earlier) + rest.totalMinor).toBe(100_000);
    expect(rest.lines).toHaveLength(1);
    expect(rest.lines[0]).toMatchObject({ quantityTicks: 12_000n, lineTotalMinor: 60_000 });
  });

  it("fără niciun storno anterior, restul e întreaga factură (linie cu linie, valorile liniei originale)", () => {
    const parent = [product("a", 12_345, 40_000n, 49_380), service("shipping", 3_500)];
    const rest = buildRemainderStorno(parent, []);
    expect(rest.totalMinor).toBe(49_380 + 3_500);
    expect(rest.taxMinor).toBe(sum(parent.map((l) => l.taxMinor)));
    expect(rest.lines.map((l) => l.kind)).toEqual(["product", "shipping"]);
  });

  it("transportul și taxa de ramburs intră în rest când nu au fost stornate, cu valorile lor din factură", () => {
    const parent = [
      product("a", 10_000, 20_000n, 20_000),
      service("shipping", 3_500, 608),
      service("cod_fee", 1_000, 174),
    ];
    const earlier = partial(parent, [], [{ orderLineId: "a", quantityTicks: 10_000n }]);
    const rest = buildRemainderStorno(parent, earlier);
    expect(earlierTotal(earlier) + rest.totalMinor).toBe(24_500);
    const shipping = rest.lines.find((l) => l.kind === "shipping");
    const cod = rest.lines.find((l) => l.kind === "cod_fee");
    expect(shipping).toMatchObject({
      lineTotalMinor: 3_500,
      taxMinor: 608,
      quantityTicks: 10_000n,
    });
    expect(cod).toMatchObject({ lineTotalMinor: 1_000, taxMinor: 174 });
    expect(rest.lines.find((l) => l.kind === "product")).toMatchObject({
      quantityTicks: 10_000n,
      lineTotalMinor: 10_000,
    });
  });

  it("linii zecimale: 6,09 mp × 123,45 = 751,81; retur parțial al cantității, apoi stornoul restului dă EXACT totalul liniei", () => {
    // 6,09 mp = 60 900 zecimi de miime; 12 345 × 6,09 = 75 181,05 → 75 181 bani
    const parent = [product("z", 12_345, 60_900n, 75_181)];
    const earlier = partial(parent, [], [{ orderLineId: "z", quantityTicks: 25_000n }]);
    const rest = buildRemainderStorno(parent, earlier);
    expect(earlierTotal(earlier) + rest.totalMinor).toBe(75_181);
    expect(rest.lines[0]?.quantityTicks).toBe(35_900n);
    expect(rest.lines[0]?.lineTotalMinor).toBe(75_181 - earlierTotal(earlier));
  });

  it("trei stornouri parțiale apoi restul: brutul total = factura, cantitatea rămasă = ce n-a fost returnat", () => {
    const parent = [product("a", 12_345, 40_000n, 49_380), product("b", 4_990, 20_000n, 9_980)];
    let earlier: StornoEarlierLine[] = [];
    earlier = partial(parent, earlier, [{ orderLineId: "a", quantityTicks: 10_000n }]);
    earlier = partial(parent, earlier, [{ orderLineId: "b", quantityTicks: 10_000n }]);
    earlier = partial(parent, earlier, [{ orderLineId: "a", quantityTicks: 10_000n }]);
    const rest = buildRemainderStorno(parent, earlier);
    expect(earlierTotal(earlier) + rest.totalMinor).toBe(49_380 + 9_980);
    const a = rest.lines.find((l) => l.orderLineId === "a");
    const b = rest.lines.find((l) => l.orderLineId === "b");
    expect(a?.quantityTicks).toBe(20_000n);
    expect(b?.quantityTicks).toBe(10_000n);
  });

  it("rest zero: totul e deja stornat pe linii și nu mai rămâne nicio linie (transportul stornat și el)", () => {
    const parent = [product("a", 10_000, 20_000n, 20_000)];
    const earlier = partial(parent, [], [{ orderLineId: "a", quantityTicks: 20_000n }]);
    const rest = buildRemainderStorno(parent, earlier);
    expect(rest.lines).toHaveLength(0);
    expect(rest.totalMinor).toBe(0);
    expect(rest.taxMinor).toBe(0);
  });

  it("rest zero și cu transportul stornat anterior (linie de serviciu în stornouri)", () => {
    const parent = [product("a", 10_000, 10_000n, 10_000), service("shipping", 3_500)];
    const earlier: StornoEarlierLine[] = [
      ...partial(parent, [], [{ orderLineId: "a", quantityTicks: 10_000n }]),
      {
        kind: "shipping",
        orderLineId: null,
        quantityTicks: 10_000n,
        lineTotalMinor: 3_500,
        taxMinor: parent[1]!.taxMinor,
      },
    ];
    expect(buildRemainderStorno(parent, earlier).lines).toHaveLength(0);
  });

  it("TVA: restul se extrage din brutul LUI; suma TVA diferă de TVA-ul liniei cu cel mult 1 ban (4 × 123,45, retur 1 buc.)", () => {
    const parent = [product("a", 12_345, 40_000n, 49_380)];
    const earlier = partial(parent, [], [{ orderLineId: "a", quantityTicks: 10_000n }]);
    const rest = buildRemainderStorno(parent, earlier);
    // brutul: exact
    expect(earlierTotal(earlier) + rest.totalMinor).toBe(49_380);
    // TVA-ul restului = extras din brutul restului (cum îl calculează furnizorul)
    expect(rest.taxMinor).toBe(vatFromGross(37_035, 2100));
    const drift = sum(earlier.map((e) => e.taxMinor)) + rest.taxMinor - parent[0]!.taxMinor;
    expect(Math.abs(drift)).toBeLessThanOrEqual(1);
  });

  it("TVA, limita pe linie: pe un set de cantități și prețuri, deriva TVA pe linie nu depășește 1 ban", () => {
    for (const unit of [12_345, 4_990, 999, 77_777, 1_001]) {
      for (const qty of [2n, 3n, 4n, 5n, 7n]) {
        for (let first = 1n; first < qty; first += 1n) {
          const ticks = qty * 10_000n;
          const total = Number((BigInt(unit) * qty * 10_000n) / 10_000n);
          const parent = [product("a", unit, ticks, total)];
          const earlier = partial(
            parent,
            [],
            [{ orderLineId: "a", quantityTicks: first * 10_000n }],
          );
          const rest = buildRemainderStorno(parent, earlier);
          expect(earlierTotal(earlier) + rest.totalMinor).toBe(total);
          const drift = sum(earlier.map((e) => e.taxMinor)) + rest.taxMinor - parent[0]!.taxMinor;
          expect(Math.abs(drift)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("stornouri care depășesc factura (cantitate sau brut) sunt refuzate, nu ascunse", () => {
    const parent = [product("a", 10_000, 20_000n, 20_000)];
    const over: StornoEarlierLine[] = [
      {
        kind: "product",
        orderLineId: "a",
        quantityTicks: 30_000n,
        lineTotalMinor: 30_000,
        taxMinor: 5_207,
      },
    ];
    expect(() => buildRemainderStorno(parent, over)).toThrowError(/depășe/i);
  });

  it("invariantul final: brutul anterior + brutul restului = brutul facturii, altfel eroare (INVOICE_TOTAL_MISMATCH)", () => {
    const parent = [product("a", 10_000, 20_000n, 20_000)];
    // retur întreg al cantității, dar cu brut mai mic decât linia: «restul» ar lăsa 5 bani nestornați fără cantitate
    const bad: StornoEarlierLine[] = [
      {
        kind: "product",
        orderLineId: "a",
        quantityTicks: 20_000n,
        lineTotalMinor: 19_995,
        taxMinor: 3_470,
      },
    ];
    expect(() => buildRemainderStorno(parent, bad)).toThrowError(
      /nu coincid|INVOICE_TOTAL_MISMATCH/i,
    );
  });
});

describe("collapseInexactLines: linia cu preț unitar × cantitate ≠ brutul ei se trimite furnizorului cu cantitatea 1", () => {
  it("6,09 mp × 123,45: restul de 3,59 mp costă 443,18 (brut exact), dar 3,59 × 123,45 = 443,19: se trimite «1 × 443,18»", () => {
    const parent = [product("z", 12_345, 60_900n, 75_181)];
    const earlier = partial(parent, [], [{ orderLineId: "z", quantityTicks: 25_000n }]);
    const rest = buildRemainderStorno(parent, earlier);
    expect(rest.lines[0]).toMatchObject({ quantityTicks: 35_900n, lineTotalMinor: 44_318 });
    const sent = collapseInexactLines(rest.lines, "serviciu");
    expect(sent[0]).toMatchObject({
      quantityTicks: 10_000n,
      unitPriceMinor: 44_318,
      lineTotalMinor: 44_318,
      unitName: "serviciu",
      taxMinor: rest.lines[0]!.taxMinor,
    });
  });

  it("o linie la care preț × cantitate dă exact brutul rămâne neschimbată", () => {
    const parent = [product("a", 10_000, 20_000n, 20_000)];
    const rest = buildRemainderStorno(
      parent,
      partial(parent, [], [{ orderLineId: "a", quantityTicks: 5_000n }]),
    );
    expect(collapseInexactLines(rest.lines, "serviciu")).toEqual(rest.lines);
  });
});
