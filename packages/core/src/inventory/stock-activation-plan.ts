import { createHash } from "node:crypto";
import type { Quantity } from "@ecom/shared";
import { normalizeUnitText } from "./smartbill-units";
import { StockError } from "./stock-errors";
import { computePlanHash, type ImportTarget } from "./stock-report-import-rules";
import {
  planStockReport,
  type StockReportPlan,
  type StockReportRow,
  type StockReportVariant,
} from "./stock-report-plan";

/**
 * Planul PUR al pornirii în masă a gestionării stocului din fișierul SmartBill (punctul 12e): ce variante devin gestionate,
 * la ce nivel (produs sau variantă), ce rămâne neatins și ce cantități se aplică în aceeași tranzacție. Fără bază de date și
 * fără fișiere; serviciul din `stock-activation.ts` îl folosește.
 *
 * Reguli (decise de utilizator):
 * - se pornește o variantă doar dacă nu e digitală, nu e oprită explicit pe variantă (`manageStock = false` pe variantă) și
 *   nu e deja gestionată; variantele deja gestionate din fișier își primesc doar cantitatea, ca la importul obișnuit;
 * - o variantă potrivită în fișier (SKU în gestiunile alese) pornește cu cantitatea din fișier; opțional (`startUnmatched`),
 *   variantele fără potrivire pornesc cu stoc 0 (raportul SmartBill listează doar produsele cu stoc);
 * - nivelul: produsul se pornește întreg doar dacă TOATE variantele lui sunt pornite acum sau deja gestionate și niciuna nu
 *   e oprită explicit; altfel se pornesc doar variantele vizate, printr-o suprascriere pe variantă (frații rămân neatinși,
 *   ca să nu devină «Indisponibil»);
 * - orice eroare de rând, depășirea plafonului sau lipsa oricărei porniri blochează aplicarea (`canApply = false`).
 */

/** Plafonul variantelor pornite într-o singură aplicare (cititorul de fișier admite până la 20.000 de rânduri). */
export const STOCK_ACTIVATION_MAX_VARIANTS = 5000;

/** Comparație pe unități de cod, ca `COLLATE "C"` din blocarea rândurilor de stoc (identificatorii sunt ASCII). */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ActivationCatalogVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  sku: string;
  /** Produs digital: fără stoc, nu se pornește niciodată */
  digital: boolean;
  /** `Product.manageStock` */
  productManage: boolean;
  /** `ProductVariant.manageStock` (suprascrierea; `null` = moștenește de la produs) */
  variantManage: boolean | null;
  /** Forma pe care o cere planul raportului, cu `manageStock` EFECTIV (varianta peste produs) */
  report: StockReportVariant;
}

export interface ActivationVariantRef {
  variantId: string;
  sku: string;
  label: string;
  productId: string;
  productTitle: string;
}

export interface ActivationChange {
  /** `product` = se schimbă `Product.manageStock`; `variant` = suprascrierea pe variantă */
  scope: "product" | "variant";
  /** Identificatorul produsului sau al variantei, după `scope` */
  id: string;
  productId: string;
  /** Variantele care devin gestionate prin această schimbare, în ordinea identificatorilor */
  variantIds: string[];
}

export interface UntouchedVariant {
  rowNumber: number;
  variantId: string;
  sku: string;
  label: string;
  reason: "explicit_off" | "digital";
}

export interface ActivationCounters {
  /** Produsele cu cel puțin o variantă pornită */
  products: number;
  /** Variante potrivite în fișier, pornite acum */
  matched: number;
  /** Variante fără potrivire, pornite cu stoc 0 (doar cu opțiunea) */
  zero: number;
  /** Variante deja gestionate, prezente în fișier: primesc doar cantitatea */
  alreadyManaged: number;
  /** Variante oprite explicit pe variantă (în tot catalogul) */
  explicitOff: number;
  /** Variante digitale (în tot catalogul) */
  digital: number;
  /** Variante care ar putea porni la 0 (fără potrivire, nedigitale, neoprite explicit, negestionate) */
  unmatchedEligible: number;
}

export interface StockActivationPlan {
  /** Raportul de import, calculat ca și cum variantele de pornit ar fi deja gestionate */
  report: StockReportPlan;
  enabled: { matched: ActivationVariantRef[]; zero: ActivationVariantRef[] };
  unmatchedEligible: ActivationVariantRef[];
  untouched: UntouchedVariant[];
  changes: ActivationChange[];
  counters: ActivationCounters;
  tooMany: boolean;
  nothingToEnable: boolean;
  maxVariants: number;
  canApply: boolean;
}

export interface PlanStockActivationInput {
  rows: readonly StockReportRow[];
  warehouses: readonly string[];
  catalog: readonly ActivationCatalogVariant[];
  /** Opțiunea explicită «Pornește și variantele fără potrivire în fișier, cu stoc 0» */
  startUnmatched: boolean;
  maxVariants: number;
}

const refOf = (v: ActivationCatalogVariant): ActivationVariantRef => ({
  variantId: v.variantId,
  sku: v.sku,
  label: v.report.label,
  productId: v.productId,
  productTitle: v.productTitle,
});

const byVariantId = (a: { variantId: string }, b: { variantId: string }): number =>
  byCodeUnits(a.variantId, b.variantId);

export function planStockActivation(input: PlanStockActivationInput): StockActivationPlan {
  const originallyManaged = new Set(
    input.catalog.filter((v) => v.report.manageStock).map((v) => v.variantId),
  );
  const eligible = new Map(
    input.catalog
      .filter((v) => !v.digital && v.variantManage !== false && !v.report.manageStock)
      .map((v) => [v.variantId, v]),
  );
  // variantele de pornit se verifică în plan ca și cum ar fi gestionate (unitate, conversie, cantitate)
  const variants = input.catalog.map((v) =>
    eligible.has(v.variantId) ? { ...v.report, manageStock: true } : v.report,
  );
  const report = planStockReport({
    rows: input.rows,
    warehouses: input.warehouses,
    variants,
  });

  const inFile = new Set(report.lines.map((line) => line.variantId));
  const matched = [...eligible.values()].filter((v) => inFile.has(v.variantId));
  const unmatched = [...eligible.values()].filter((v) => !inFile.has(v.variantId));
  const zero = input.startUnmatched ? unmatched : [];
  const enabled = [...matched, ...zero];
  const enabledIds = new Set(enabled.map((v) => v.variantId));

  const byProduct = new Map<string, ActivationCatalogVariant[]>();
  for (const v of input.catalog) {
    const list = byProduct.get(v.productId) ?? [];
    list.push(v);
    byProduct.set(v.productId, list);
  }

  const changes: ActivationChange[] = [];
  const touchedProducts = new Set(enabled.map((v) => v.productId));
  for (const productId of touchedProducts) {
    const siblings = byProduct.get(productId) ?? [];
    const target = siblings.filter((v) => enabledIds.has(v.variantId)).map((v) => v.variantId);
    // o variantă pornită acum are produsul oprit și nu e oprită pe variantă (altfel nu era eligibilă), deci acoperirea întreagă
    // (toate variantele pornite acum sau deja gestionate) exclude de la sine digitalele și variantele oprite explicit
    const wholeProduct = siblings.every(
      (v) => enabledIds.has(v.variantId) || originallyManaged.has(v.variantId),
    );
    if (wholeProduct) {
      changes.push({
        scope: "product",
        id: productId,
        productId,
        variantIds: [...target].sort(byCodeUnits),
      });
    } else {
      for (const variantId of target) {
        changes.push({ scope: "variant", id: variantId, productId, variantIds: [variantId] });
      }
    }
  }
  changes.sort((a, b) => byCodeUnits(a.id, b.id));

  const catalogById = new Map(input.catalog.map((v) => [v.variantId, v]));
  const untouched: UntouchedVariant[] = report.unmanaged.map((entry) => {
    const source = catalogById.get(entry.variantId);
    return {
      rowNumber: entry.rowNumber,
      variantId: entry.variantId,
      sku: entry.sku,
      label: entry.label,
      reason: source?.digital ? "digital" : "explicit_off",
    };
  });

  const counters: ActivationCounters = {
    products: touchedProducts.size,
    matched: matched.length,
    zero: zero.length,
    alreadyManaged: report.lines.filter((l) => originallyManaged.has(l.variantId)).length,
    explicitOff: input.catalog.filter((v) => !v.digital && v.variantManage === false).length,
    digital: input.catalog.filter((v) => v.digital).length,
    unmatchedEligible: unmatched.length,
  };
  const tooMany = enabled.length > input.maxVariants;
  const nothingToEnable = enabled.length === 0;
  return {
    report,
    enabled: {
      matched: matched.map(refOf).sort(byVariantId),
      zero: zero.map(refOf).sort(byVariantId),
    },
    unmatchedEligible: unmatched.map(refOf).sort(byVariantId),
    untouched,
    changes,
    counters,
    tooMany,
    nothingToEnable,
    maxVariants: input.maxVariants,
    canApply: report.canApply && !tooMany && !nothingToEnable,
  };
}

/**
 * Ce se aplică, în ordinea fixă a blocării rândurilor de stoc: liniile din fișier (variantele pornite acum și cele deja
 * gestionate) și, cu opțiunea, variantele fără potrivire cu 0. Un plan care nu se poate aplica nu produce nimic.
 */
export function selectActivationTargets(plan: StockActivationPlan): ImportTarget[] {
  if (!plan.canApply) {
    throw new StockError(
      "STOCK_ACTIVATION_NOT_APPLICABLE",
      "Pornirea nu se poate aplica: raportul are erori, depășește plafonul sau nu are nimic de pornit. Nu s-a aplicat nimic.",
    );
  }
  const targets: ImportTarget[] = plan.report.lines.map((line) => ({
    variantId: line.variantId,
    sku: line.sku,
    kind: "file",
    quantity: line.quantity,
  }));
  for (const v of plan.enabled.zero) {
    targets.push({ variantId: v.variantId, sku: v.sku, kind: "zeroed", quantity: 0n as Quantity });
  }
  return targets.sort((a, b) => byCodeUnits(a.variantId, b.variantId));
}

export interface ActivationConfirm {
  products: number;
  variants: number;
  zero: number;
}

/** Numerele văzute în previzualizare trebuie să fie exact cele de acum (cum se confirmă «lipsă → 0» la import). */
export function checkActivationConfirm(
  plan: StockActivationPlan,
  confirm: ActivationConfirm,
): void {
  const { products, matched, zero } = plan.counters;
  if (confirm.products !== products || confirm.variants !== matched || confirm.zero !== zero) {
    throw new StockError(
      "STOCK_ACTIVATION_COUNT_MISMATCH",
      "Numerele din previzualizare s-au schimbat. Verifică din nou înainte de a aplica.",
      {
        expected: { products, variants: matched, zero },
        received: confirm,
      },
    );
  }
}

export interface ActivationHashInput {
  fileHash: string;
  warehouses: readonly string[];
  startUnmatched: boolean;
  plan: StockActivationPlan;
}

/**
 * Amprenta a ceea ce a văzut utilizatorul: amprenta raportului (fișier, gestiuni, linii cu stocul lor curent, variante lipsă)
 * plus opțiunea, schimbările de bifă (nivel, țintă, variante) și variantele pornite la 0. O bifă schimbată în catalog după
 * previzualizare schimbă amprenta, deci aplicarea se refuză. Nu depinde de ora curentă.
 */
export function computeActivationHash(input: ActivationHashInput): string {
  const base = computePlanHash({
    fileHash: input.fileHash,
    warehouses: input.warehouses.map((name) => normalizeUnitText(name)),
    plan: input.plan.report,
  });
  const changes = input.plan.changes.map((c) => `C|${c.scope}|${c.id}|${c.variantIds.join(",")}`);
  const text = [`base|${base}`, `start|${input.startUnmatched ? 1 : 0}`, ...changes].join("\n");
  return createHash("sha256").update(text).digest("hex");
}
