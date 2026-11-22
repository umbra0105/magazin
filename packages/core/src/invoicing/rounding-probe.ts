import {
  formatQuantity,
  parseQuantity,
  quantityFromTicks,
  type InvoiceDocLine,
  type Quantity,
} from "@ecom/shared";
import { computeOrderTotals } from "../orders/order-totals";
import { priceLines, type PricingLineInput } from "../pricing";
import { buildInvoiceDraft, toDocLines, type DraftLine, type DraftOrder } from "./invoice-draft";

/**
 * Verificarea rotunjirii în contul SmartBill (punctul ⚠️ din docs/06, decizia 2026-11-22): cele 3 comenzi de probă cu linii zecimale,
 * calculate cu MOTORUL DE PREȚURI real și cu aceleași funcții ca la checkout, și raportul «identic / diferență de N bani». Doar logică
 * pură (fără rețea, fără bază de date): scriptul `scripts/facturare/verifica-rotunjirea.ts` o folosește, dar îl pornește OMUL, într-un
 * cont de test; nicio rulare automată nu emite documente. Rezultatul NU dovedește nimic despre SmartBill până nu se rulează acolo.
 */
const NOW = new Date("2026-06-01T10:00:00.000Z");
const RATE_BPS = 2100;
const ONE: Quantity = quantityFromTicks(10_000n);

interface ProbeItem {
  sku: string;
  title: string;
  unitSymbol: string;
  priceMinor: number;
  quantity: string;
}

export interface ProbeScenario {
  id: string;
  title: string;
  items: readonly ProbeItem[];
  shippingMinor: number;
  codFeeMinor: number;
}

/** Cele 3 comenzi de probă (docs/06 și docs/09 §2): liniile zecimale, coșul cu TVA pe linii de 1.819,15, transportul, taxa și paletul. */
export const PROBE_SCENARIOS: readonly ProbeScenario[] = [
  {
    id: "1",
    title:
      "Coșul din docs/09: mozaic 6,09 mp × 123,45, bisulfat 2 saci × 120,00 și un produs de 9.490,00",
    items: [
      {
        sku: "PROBA-MOZAIC",
        title: "Mozaic piscină (probă)",
        unitSymbol: "mp",
        priceMinor: 12_345,
        quantity: "6,09",
      },
      {
        sku: "PROBA-BISULFAT",
        title: "Bisulfat (probă)",
        unitSymbol: "sac",
        priceMinor: 12_000,
        quantity: "2",
      },
      {
        sku: "PROBA-ECHIPAMENT",
        title: "Echipament (probă)",
        unitSymbol: "buc",
        priceMinor: 949_000,
        quantity: "1",
      },
    ],
    shippingMinor: 0,
    codFeeMinor: 0,
  },
  {
    id: "2",
    title: "Liner 41,25 mp × 89,90 (jumătate de ban rotunjită în sus) cu transport de 35,00",
    items: [
      {
        sku: "PROBA-LINER",
        title: "Liner piscină (probă)",
        unitSymbol: "mp",
        priceMinor: 8_990,
        quantity: "41,25",
      },
    ],
    shippingMinor: 3_500,
    codFeeMinor: 0,
  },
  {
    id: "3",
    title: "Mozaic 6,09 mp × 123,45 cu transport paletizat de 350,00 și taxă de ramburs de 15,00",
    items: [
      {
        sku: "PROBA-MOZAIC",
        title: "Mozaic piscină (probă)",
        unitSymbol: "mp",
        priceMinor: 12_345,
        quantity: "6,09",
      },
    ],
    shippingMinor: 35_000,
    codFeeMinor: 1_500,
  },
];

export interface ProbeExpectation {
  scenario: ProbeScenario;
  order: DraftOrder;
  lines: DraftLine[];
  docLines: InvoiceDocLine[];
  totalMinor: number;
  taxMinor: number;
}

/** Comanda de probă exact cum ar ieși din motorul de prețuri și din `computeOrderTotals`, apoi liniile facturii. */
export function buildProbe(scenario: ProbeScenario): ProbeExpectation {
  const inputs: PricingLineInput[] = scenario.items.map((item) => ({
    key: item.sku,
    productId: `p-${item.sku}`,
    categoryIds: [],
    basis: "unit",
    priceMinor: item.priceMinor,
    salePriceMinor: null,
    quantity: parseQuantity(item.quantity, { maxDecimals: 4 }),
    step: ONE,
    taxRateBps: RATE_BPS,
    excludeFromGroupDiscount: false,
    costNetMinor: null,
  }));
  const priced = priceLines(inputs, {
    applySale: true,
    group: { pricingType: "none" },
    coupon: null,
    now: NOW,
    maxLineMinor: 1_000_000_000,
  });
  const totals = computeOrderTotals({
    cart: { totalMinor: priced.totals.totalMinor, vatMinor: priced.totals.vatMinor },
    shippingMinor: scenario.shippingMinor,
    codFeeMinor: scenario.codFeeMinor,
    paymentMethod: scenario.codFeeMinor > 0 ? "cod" : "card",
    taxRateBps: RATE_BPS,
  });
  const order: DraftOrder = {
    lines: priced.lines.map((line, index) => {
      const item = scenario.items[index] as ProbeItem;
      return {
        id: `probe-${item.sku}`,
        sku: item.sku,
        title: item.title,
        variantTitle: null,
        quantityTicks: parseQuantity(item.quantity, { maxDecimals: 4 }),
        unitSymbol: item.unitSymbol,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.totalMinor,
        netMinor: line.netMinor,
        taxMinor: line.vatMinor,
        taxRateBps: RATE_BPS,
        dischargeable: false,
      };
    }),
    discountMinor: 0,
    shippingMinor: totals.shippingMinor,
    shippingTaxMinor: totals.shippingTaxMinor,
    codFeeMinor: totals.codFeeMinor,
    codFeeTaxMinor: totals.codFeeTaxMinor,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    taxRateBps: RATE_BPS,
  };
  const draft = buildInvoiceDraft(order, {
    unitName: (symbol) => symbol,
    labels: {
      shipping: "Transport (probă)",
      codFee: "Taxă de ramburs (probă)",
      serviceUnit: "buc",
    },
  });
  return {
    scenario,
    order,
    lines: draft.lines,
    docLines: toDocLines(draft.lines),
    totalMinor: draft.totalMinor,
    taxMinor: draft.taxMinor,
  };
}

export type ProbeVerdict = "identic" | "diferență" | "necitit";

export interface ProbeComparison {
  verdict: ProbeVerdict;
  /** Diferența în bani (furnizor − magazin); `null` dacă furnizorul nu a dat totalul. */
  diffMinor: number | null;
}

export function compareMinor(shopMinor: number, providerMinor: number | null): ProbeComparison {
  if (providerMinor === null) return { verdict: "necitit", diffMinor: null };
  const diff = providerMinor - shopMinor;
  return { verdict: diff === 0 ? "identic" : "diferență", diffMinor: diff };
}

const lei = (minor: number): string => {
  const sign = minor < 0 ? "-" : "";
  const digits = String(Math.abs(minor)).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${whole},${digits.slice(-2)} lei`;
};

export interface ProbeResult {
  expectation: ProbeExpectation;
  /** SERIA și numărul documentului emis, sau `null` dacă emiterea a eșuat. */
  document: { series: string; number: string } | null;
  /** Totalul citit de la SmartBill (bani), sau `null`. */
  providerTotalMinor: number | null;
  /** Calea PDF-ului salvat, pentru compararea TVA-ului pe linii cu ochiul. */
  pdfPath: string | null;
  /** Eroarea (fără date personale) dacă emiterea a eșuat. */
  error: string | null;
}

const qtyText = (ticks: bigint): string =>
  formatQuantity(quantityFromTicks(ticks), { maxDecimals: 2 });

/** Raportul în limbaj simplu: ce a încasat magazinul, ce arată SmartBill, «identic» sau «diferență de N bani», și ce se verifică în PDF. */
export function renderProbeReport(results: readonly ProbeResult[]): {
  text: string;
  allIdentical: boolean;
} {
  const out: string[] = [];
  let allIdentical = results.length > 0;
  out.push("RAPORT: verificarea rotunjirii în contul SmartBill de test");
  out.push("=".repeat(60));
  for (const result of results) {
    const { expectation: e } = result;
    out.push("");
    out.push(`Comanda de probă ${e.scenario.id}: ${e.scenario.title}`);
    out.push("Liniile (ce a încasat magazinul, o rotunjire pe linie, TVA din brutul liniei):");
    for (const line of e.lines) {
      out.push(
        `  - ${line.title}: ${qtyText(line.quantityTicks)} ${line.unitName} × ${lei(line.unitPriceMinor)} = ${lei(line.lineTotalMinor)} (din care TVA ${lei(line.taxMinor)})`,
      );
    }
    out.push(
      `Total încasat de magazin: ${lei(e.totalMinor)}; TVA total (suma pe linii): ${lei(e.taxMinor)}`,
    );
    if (result.error) {
      allIdentical = false;
      out.push(`NU s-a putut emite documentul: ${result.error}`);
      continue;
    }
    const total = compareMinor(e.totalMinor, result.providerTotalMinor);
    if (total.verdict !== "identic") allIdentical = false;
    out.push(
      `Document emis: ${result.document ? `${result.document.series} ${result.document.number}` : "?"}`,
    );
    out.push(
      `Total pe factura SmartBill: ${result.providerTotalMinor === null ? "necitit" : lei(result.providerTotalMinor)} → ${
        total.verdict === "identic"
          ? "IDENTIC"
          : total.verdict === "necitit"
            ? "NECITIT (verifică în SmartBill)"
            : `DIFERENȚĂ de ${Math.abs(total.diffMinor ?? 0)} ${Math.abs(total.diffMinor ?? 0) === 1 ? "ban" : "bani"}`
      }`,
    );
    out.push(
      `TVA și liniile: API-ul SmartBill nu le dă înapoi. Deschide PDF-ul (${result.pdfPath ?? "nesalvat"}) și compară fiecare linie și TVA-ul cu cifrele de mai sus; pe fiecare linie TVA trebuie să fie exact cel din paranteză, iar TVA total ${lei(e.taxMinor)}.`,
    );
  }
  out.push("");
  out.push(
    allIdentical
      ? "REZULTAT: totalurile sunt IDENTICE. Dacă și TVA-ul de pe PDF-uri coincide pe fiecare linie, poți confirma testul cu cont real în Setări → Facturare."
      : "REZULTAT: există diferențe sau documente neemise. NU trece în LIVE. Trimite acest raport (fără chei) înainte de orice altceva.",
  );
  return { text: out.join("\n"), allIdentical };
}
