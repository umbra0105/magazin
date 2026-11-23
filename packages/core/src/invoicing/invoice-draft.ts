import {
  DomainError,
  INVOICE_QUANTITY_TICK_MULTIPLE,
  QUANTITY_FACTOR,
  exactFromMinor,
  type InvoiceDocLine,
  lineByUnitPrice,
  quantityFromTicks,
  roundHalfUp,
  vatFromGross,
} from "@ecom/shared";

/**
 * Construirea liniilor unei facturi sau proforme DIN comanda înghețată (Faza 13). Funcții PURE: fără bază de date, fără ceas.
 *
 * Regula de aur (BANI): ce iese pe factură, pe fiecare linie și pe total, e EXACT ce a încasat magazinul. Liniile de produs vin
 * din liniile comenzii (total și TVA deja calculate de motorul de prețuri, o rotunjire pe linie); transportul și taxa de ramburs
 * sunt linii separate, cu TVA-ul extras din brut (ca pe comandă). Totalul facturii = suma liniilor, TVA-ul = suma TVA-urilor pe
 * linii. Construcția REFUZĂ (`INVOICE_TOTAL_MISMATCH`) dacă suma liniilor sau TVA-ul nu coincid cu comanda: nu se emite o factură
 * cu alt număr decât cel încasat.
 */
export const INVOICE_DRAFT_CODES = [
  "INVOICE_TOTAL_MISMATCH",
  "INVOICE_QUANTITY_PRECISION",
  "INVOICE_UNSUPPORTED_ORDER",
  "INVOICE_RETURN_INVALID",
  /** Stornourile existente depășesc factura (cantitate sau brut): nu se mai creează niciun document peste ele. */
  "INVOICE_STORNO_EXCEEDS_TOTAL",
] as const;
export type InvoiceDraftCode = (typeof INVOICE_DRAFT_CODES)[number];

export class InvoiceDraftError extends DomainError {
  constructor(code: InvoiceDraftCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}

export interface DraftOrderLine {
  id: string;
  sku: string;
  title: string;
  variantTitle: string | null;
  quantityTicks: bigint;
  unitSymbol: string;
  unitPriceMinor: number;
  lineTotalMinor: number;
  netMinor: number;
  taxMinor: number;
  taxRateBps: number;
  /** Linia are stoc gestionat (angajare la comandă): se poate descărca din gestiune la furnizor. */
  dischargeable: boolean;
}

export interface DraftOrder {
  lines: readonly DraftOrderLine[];
  discountMinor: number;
  shippingMinor: number;
  shippingTaxMinor: number;
  codFeeMinor: number;
  codFeeTaxMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxRateBps: number;
}

export interface DraftLine {
  kind: "product" | "shipping" | "cod_fee";
  orderLineId: string | null;
  sku: string | null;
  title: string;
  unitName: string;
  quantityTicks: bigint;
  unitPriceMinor: number;
  lineTotalMinor: number;
  netMinor: number;
  taxMinor: number;
  taxRateBps: number;
  dischargeStock: boolean;
}

export interface DraftLabels {
  shipping: string;
  codFee: string;
  /** Unitatea pentru servicii (transport, taxă): numele din contul furnizorului. */
  serviceUnit: string;
}

export interface BuildDraftOptions {
  /** Numele unității din contul furnizorului, pornind de la simbolul unității din magazin. */
  unitName: (symbol: string) => string;
  labels: DraftLabels;
}

export interface InvoiceDraft {
  lines: DraftLine[];
  totalMinor: number;
  taxMinor: number;
  /** Factura cere descărcarea de gestiune: există produse și TOATE se descarcă (SmartBill: o singură bifă pe factură). */
  useStock: boolean;
  /** Pozițiile (de la 1) liniilor emise «cantitate 1», fiindcă prețul unitar rotunjit × cantitatea nu dă totalul încasat. */
  collapsedPositions: number[];
}

const ONE_UNIT_TICKS = QUANTITY_FACTOR;

const sum = (values: readonly number[]): number => values.reduce((acc, v) => acc + v, 0);

/** Cantitatea are cel mult 2 zecimale (multiplu de 100 de zecimi de miime): altfel SmartBill ar rotunji în tăcere. */
export function isInvoiceQuantity(ticks: bigint): boolean {
  const abs = ticks < 0n ? -ticks : ticks;
  return abs % INVOICE_QUANTITY_TICK_MULTIPLE === 0n;
}

/** `round(preț unitar × cantitate)`, o singură rotunjire half-up, exact ca motorul de prețuri pe o linie cu preț unitar întreg. */
export function lineTotalFromUnit(unitPriceMinor: number, quantityTicks: bigint): number {
  const abs = quantityTicks < 0n ? -quantityTicks : quantityTicks;
  const total = Number(
    roundHalfUp(lineByUnitPrice(exactFromMinor(unitPriceMinor), quantityFromTicks(abs))),
  );
  return quantityTicks < 0n ? -total : total;
}

function serviceLine(
  kind: "shipping" | "cod_fee",
  title: string,
  unitName: string,
  grossMinor: number,
  taxMinor: number,
  taxRateBps: number,
): DraftLine {
  return {
    kind,
    orderLineId: null,
    sku: null,
    title,
    unitName,
    quantityTicks: ONE_UNIT_TICKS,
    unitPriceMinor: grossMinor,
    lineTotalMinor: grossMinor,
    netMinor: grossMinor - taxMinor,
    taxMinor,
    taxRateBps,
    dischargeStock: false,
  };
}

export function buildInvoiceDraft(order: DraftOrder, options: BuildDraftOptions): InvoiceDraft {
  if (order.discountMinor !== 0) {
    // reducerile la nivel de comandă (cupon, puncte) vin în Fazele 15 și 15b și vor avea linie proprie; până atunci nu se ghicesc
    throw new InvoiceDraftError(
      "INVOICE_UNSUPPORTED_ORDER",
      "Comanda are o reducere la nivel de comandă, pe care factura nu o poate reprezenta încă",
    );
  }
  const lines: DraftLine[] = [];
  const collapsed: number[] = [];
  for (const line of order.lines) {
    if (!isInvoiceQuantity(line.quantityTicks)) {
      throw new InvoiceDraftError(
        "INVOICE_QUANTITY_PRECISION",
        `Produsul ${line.sku}: cantitatea comandată are mai mult de 2 zecimale, iar factura acceptă cel mult 2`,
        { sku: line.sku },
      );
    }
    const unitName = options.unitName(line.unitSymbol);
    const exact =
      lineTotalFromUnit(line.unitPriceMinor, line.quantityTicks) === line.lineTotalMinor;
    if (exact) {
      lines.push({
        kind: "product",
        orderLineId: line.id,
        sku: line.sku,
        title: line.variantTitle ? `${line.title} (${line.variantTitle})` : line.title,
        unitName,
        quantityTicks: line.quantityTicks,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
        netMinor: line.netMinor,
        taxMinor: line.taxMinor,
        taxRateBps: line.taxRateBps,
        dischargeStock: line.dischargeable,
      });
    } else {
      // prețul unitar rotunjit × cantitatea nu dă totalul încasat (preț de grup fracționar sau cupon): linia se emite cu
      // cantitatea 1 și totalul EXACT încasat, ca factura să nu difere cu 1 ban; nu se descarcă din gestiune
      collapsed.push(lines.length + 1);
      lines.push({
        kind: "product",
        orderLineId: line.id,
        sku: line.sku,
        title: line.variantTitle ? `${line.title} (${line.variantTitle})` : line.title,
        unitName: options.labels.serviceUnit,
        quantityTicks: ONE_UNIT_TICKS,
        unitPriceMinor: line.lineTotalMinor,
        lineTotalMinor: line.lineTotalMinor,
        netMinor: line.netMinor,
        taxMinor: line.taxMinor,
        taxRateBps: line.taxRateBps,
        dischargeStock: false,
      });
    }
  }
  if (order.shippingMinor > 0) {
    lines.push(
      serviceLine(
        "shipping",
        options.labels.shipping,
        options.labels.serviceUnit,
        order.shippingMinor,
        order.shippingTaxMinor,
        order.taxRateBps,
      ),
    );
  }
  if (order.codFeeMinor > 0) {
    lines.push(
      serviceLine(
        "cod_fee",
        options.labels.codFee,
        options.labels.serviceUnit,
        order.codFeeMinor,
        order.codFeeTaxMinor,
        order.taxRateBps,
      ),
    );
  }

  const totalMinor = sum(lines.map((l) => l.lineTotalMinor));
  const taxMinor = sum(lines.map((l) => l.taxMinor));
  if (totalMinor !== order.totalMinor || taxMinor !== order.taxMinor) {
    throw new InvoiceDraftError(
      "INVOICE_TOTAL_MISMATCH",
      `Liniile facturii (total ${totalMinor}, TVA ${taxMinor}) nu coincid cu comanda (total ${order.totalMinor}, TVA ${order.taxMinor})`,
      {
        linesTotal: totalMinor,
        orderTotal: order.totalMinor,
        linesTax: taxMinor,
        orderTax: order.taxMinor,
      },
    );
  }
  const products = lines.filter((l) => l.kind === "product");
  return {
    lines,
    totalMinor,
    taxMinor,
    useStock: products.length > 0 && products.every((l) => l.dischargeStock),
    collapsedPositions: collapsed,
  };
}

// ---------------------------------------------------------------------------
// Storno parțial (retur parțial): doar pe produse; transportul NU se stornează automat (decizia 2026-11-22)
// ---------------------------------------------------------------------------

export interface StornoSourceLine {
  orderLineId: string;
  sku: string;
  title: string;
  unitName: string;
  quantityTicks: bigint;
  unitPriceMinor: number;
  lineTotalMinor: number;
  taxMinor: number;
  taxRateBps: number;
}

/** Ce s-a stornat deja din linia originală (suma documentelor storno emise sau în coadă). */
export interface StornoReturned {
  quantityTicks: bigint;
  lineTotalMinor: number;
  taxMinor: number;
}

export interface StornoRequestLine {
  orderLineId: string;
  quantityTicks: bigint;
}

export interface PartialStorno {
  /** Liniile cu cantitate și sume POZITIVE (așa se păstrează în `invoice_line`); spre furnizor se trimit negate (`negateLines`). */
  lines: DraftLine[];
  totalMinor: number;
  taxMinor: number;
}

/**
 * Liniile unui storno parțial. Suma unei returnări parțiale = `round(preț unitar × cantitate)`; ULTIMA bucată din linie ia
 * restul exact al TOTALULUI (total original minus ce s-a stornat deja), ca suma stornourilor unei linii să fie EXACT totalul liniei.
 * Cantitatea totală stornată nu poate depăși cantitatea facturată.
 */
export function buildPartialStorno(
  source: readonly StornoSourceLine[],
  returned: ReadonlyMap<string, StornoReturned>,
  requested: readonly StornoRequestLine[],
): PartialStorno {
  if (requested.length === 0) {
    throw new InvoiceDraftError("INVOICE_RETURN_INVALID", "Stornoul parțial nu are nicio linie");
  }
  const seen = new Set<string>();
  const lines: DraftLine[] = [];
  for (const req of requested) {
    if (seen.has(req.orderLineId)) {
      throw new InvoiceDraftError("INVOICE_RETURN_INVALID", "O linie apare de două ori în storno");
    }
    seen.add(req.orderLineId);
    const original = source.find((l) => l.orderLineId === req.orderLineId);
    if (!original) {
      throw new InvoiceDraftError(
        "INVOICE_RETURN_INVALID",
        "Linia nu face parte din factura originală",
      );
    }
    if (req.quantityTicks <= 0n || !isInvoiceQuantity(req.quantityTicks)) {
      throw new InvoiceDraftError(
        "INVOICE_RETURN_INVALID",
        `Produsul ${original.sku}: cantitatea returnată trebuie să fie pozitivă, cu cel mult 2 zecimale`,
      );
    }
    const done = returned.get(req.orderLineId) ?? {
      quantityTicks: 0n,
      lineTotalMinor: 0,
      taxMinor: 0,
    };
    const remaining = original.quantityTicks - done.quantityTicks;
    if (req.quantityTicks > remaining) {
      throw new InvoiceDraftError(
        "INVOICE_RETURN_INVALID",
        `Produsul ${original.sku}: se returnează mai mult decât a rămas din cantitatea facturată`,
      );
    }
    const isLast = req.quantityTicks === remaining;
    const total = isLast
      ? original.lineTotalMinor - done.lineTotalMinor
      : lineTotalFromUnit(original.unitPriceMinor, req.quantityTicks);
    // TVA-ul fiecărei linii se extrage din brutul ei, ca la orice linie (și cum o calculează furnizorul); suma TVA-urilor unei linii
    // stornate în bucăți poate diferi cu cel mult câțiva bani de TVA-ul liniei originale (de confirmat cu contabilul)
    const tax = vatFromGross(total, original.taxRateBps);
    lines.push({
      kind: "product",
      orderLineId: original.orderLineId,
      sku: original.sku,
      title: original.title,
      unitName: original.unitName,
      quantityTicks: req.quantityTicks,
      unitPriceMinor: original.unitPriceMinor,
      lineTotalMinor: total,
      netMinor: total - tax,
      taxMinor: tax,
      taxRateBps: original.taxRateBps,
      dischargeStock: false,
    });
  }
  return {
    lines,
    totalMinor: sum(lines.map((l) => l.lineTotalMinor)),
    taxMinor: sum(lines.map((l) => l.taxMinor)),
  };
}

// ---------------------------------------------------------------------------
// Stornoul «total» ca REST nestornat (mini-faza storno-total, decizia 2026-11-23)
// ---------------------------------------------------------------------------

/** O linie a facturii de stornat (produs, transport sau taxă de ramburs), așa cum e înghețată pe documentul emis. */
export interface StornoParentLine {
  kind: "product" | "shipping" | "cod_fee";
  orderLineId: string | null;
  sku: string | null;
  title: string;
  unitName: string;
  quantityTicks: bigint;
  unitPriceMinor: number;
  lineTotalMinor: number;
  netMinor: number;
  taxMinor: number;
  taxRateBps: number;
}

/** O linie dintr-un storno existent (parțial), cu cantitate și sume POZITIVE, ca în `invoice_line`. */
export interface StornoEarlierLine {
  kind: string;
  orderLineId: string | null;
  quantityTicks: bigint;
  lineTotalMinor: number;
  taxMinor: number;
}

/**
 * Restul nestornat al unei facturi: pe fiecare linie, cantitatea și brutul rămase după toate stornourile existente (ultima bucată ia
 * restul EXACT al brutului liniei). Liniile neatinse de stornouri se copiază cu valorile lor din factură (inclusiv TVA); liniile
 * atinse primesc TVA extras din brutul restului, ca orice storno (decizia 2026-11-23: suma TVA poate diferi de TVA-ul liniei cu cel
 * mult 1 ban, de confirmat cu contabilul). Transportul și taxa de ramburs intră în rest cât timp nu au fost stornate.
 *
 * Refuză (nu ascunde): stornouri care depășesc cantitatea sau brutul unei linii, sau un total care nu se închide la ban
 * (`brut stornat anterior + brut rest = brutul facturii`).
 */
export function buildRemainderStorno(
  parent: readonly StornoParentLine[],
  earlier: readonly StornoEarlierLine[],
): PartialStorno {
  const keyOf = (l: { kind: string; orderLineId: string | null }): string =>
    l.orderLineId ?? `kind:${l.kind}`;
  const done = new Map<string, { quantityTicks: bigint; lineTotalMinor: number }>();
  for (const e of earlier) {
    const prev = done.get(keyOf(e)) ?? { quantityTicks: 0n, lineTotalMinor: 0 };
    done.set(keyOf(e), {
      quantityTicks: prev.quantityTicks + e.quantityTicks,
      lineTotalMinor: prev.lineTotalMinor + e.lineTotalMinor,
    });
  }
  const known = new Set(parent.map(keyOf));
  for (const key of done.keys()) {
    if (!known.has(key)) {
      throw new InvoiceDraftError(
        "INVOICE_RETURN_INVALID",
        "Un storno existent are o linie care nu face parte din factura originală",
      );
    }
  }
  const lines: DraftLine[] = [];
  for (const p of parent) {
    const d = done.get(keyOf(p)) ?? { quantityTicks: 0n, lineTotalMinor: 0 };
    const remainingQty = p.quantityTicks - d.quantityTicks;
    const remainingTotal = p.lineTotalMinor - d.lineTotalMinor;
    if (remainingQty < 0n || remainingTotal < 0) {
      throw new InvoiceDraftError(
        "INVOICE_STORNO_EXCEEDS_TOTAL",
        `Stornourile existente depășesc factura la linia «${p.title}»`,
        { orderLineId: p.orderLineId, kind: p.kind },
      );
    }
    if (remainingQty === 0n) {
      if (remainingTotal !== 0) {
        throw new InvoiceDraftError(
          "INVOICE_TOTAL_MISMATCH",
          `Linia «${p.title}» e stornată integral ca cantitate, dar brutul stornat și cel al facturii nu coincid`,
          { remainingTotal },
        );
      }
      continue;
    }
    const untouched = d.quantityTicks === 0n && d.lineTotalMinor === 0;
    const tax = untouched ? p.taxMinor : vatFromGross(remainingTotal, p.taxRateBps);
    lines.push({
      kind: p.kind,
      orderLineId: p.orderLineId,
      sku: p.sku,
      title: p.title,
      unitName: p.unitName,
      quantityTicks: remainingQty,
      unitPriceMinor: p.unitPriceMinor,
      lineTotalMinor: remainingTotal,
      netMinor: untouched ? p.netMinor : remainingTotal - tax,
      taxMinor: tax,
      taxRateBps: p.taxRateBps,
      dischargeStock: false,
    });
  }
  const totalMinor = sum(lines.map((l) => l.lineTotalMinor));
  const earlierMinor = sum(earlier.map((e) => e.lineTotalMinor));
  const invoiceMinor = sum(parent.map((l) => l.lineTotalMinor));
  if (earlierMinor + totalMinor !== invoiceMinor) {
    throw new InvoiceDraftError(
      "INVOICE_TOTAL_MISMATCH",
      `Brutul stornat (${earlierMinor} + ${totalMinor} bani) nu coincide cu brutul facturii (${invoiceMinor} bani)`,
      { earlierMinor, remainderMinor: totalMinor, invoiceMinor },
    );
  }
  return { lines, totalMinor, taxMinor: sum(lines.map((l) => l.taxMinor)) };
}

/**
 * Liniile restului, pregătite pentru furnizor: dacă `round(preț unitar × cantitate)` nu dă brutul rămas al liniei (ultima bucată ia
 * restul EXACT, iar furnizorul recalculează preț × cantitate), linia pleacă «cantitatea 1 × brutul rămas», ca la factură
 * (`buildInvoiceDraft`, aceeași regulă: documentul nu diferă cu 1 ban de ce s-a încasat). În baza noastră rămân cantitatea reală.
 */
export function collapseInexactLines(
  lines: readonly DraftLine[],
  serviceUnit: string,
): DraftLine[] {
  return lines.map((l) => {
    if (lineTotalFromUnit(l.unitPriceMinor, l.quantityTicks) === l.lineTotalMinor) return l;
    return {
      ...l,
      quantityTicks: ONE_UNIT_TICKS,
      unitPriceMinor: l.lineTotalMinor,
      unitName: serviceUnit,
      dischargeStock: false,
    };
  });
}

/** Liniile unui storno parțial așa cum le primește furnizorul: cantitate și sume cu semn schimbat (factură cu cantități negative). */
export function negateLines<
  T extends { quantityTicks: bigint; lineTotalMinor: number; taxMinor: number },
>(lines: readonly T[]): T[] {
  return lines.map((l) => ({
    ...l,
    quantityTicks: -l.quantityTicks,
    lineTotalMinor: -l.lineTotalMinor,
    taxMinor: -l.taxMinor,
  }));
}

/** Linia așa cum o cere contractul furnizorului (`InvoiceDocLine`): denumirea și SKU-ul, fără câmpuri interne. */
export function toDocLines(lines: readonly DraftLine[]): InvoiceDocLine[] {
  return lines.map((l) => ({
    kind: l.kind,
    name: l.title,
    code: l.sku,
    unitName: l.unitName,
    quantityTicks: l.quantityTicks,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: l.lineTotalMinor,
    taxMinor: l.taxMinor,
    taxRateBps: l.taxRateBps,
    dischargeStock: l.dischargeStock,
  }));
}
