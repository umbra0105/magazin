import { discountShareForReturn } from "../pricing/points";
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
  /**
   * Produs digital (Faza 14b): intră pe factură ca orice linie, dar NICIODATĂ cu descărcare de gestiune, și nu oprește descărcarea
   * celorlalte linii (are un singur `useStock` pe factură, iar o linie digitală nu are stoc de descărcat).
   */
  digital?: boolean;
  /** Partea de reducere din puncte a liniei și TVA-ul ei (Faza 15b); lipsesc sau 0 fără puncte. */
  loyaltyDiscountMinor?: number;
  loyaltyDiscountTaxMinor?: number;
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

/** `discount`: sume POZITIVE aici și în `invoice_line`; în totaluri se SCAD (semnul îl dă tipul). */
export type DraftLineKind = "product" | "shipping" | "cod_fee" | "discount";

export interface DraftLine {
  kind: DraftLineKind;
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
  /** Denumirea rândului de reducere din puncte (se completează cu numele produsului). */
  pointsDiscount?: string;
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

/** Contribuția unei linii la total și la TVA: rândurile de reducere se scad. */
const signOf = (line: { kind: string }): 1 | -1 => (line.kind === "discount" ? -1 : 1);
const signedTotal = (lines: ReadonlyArray<{ kind: string; lineTotalMinor: number }>): number =>
  sum(lines.map((l) => signOf(l) * l.lineTotalMinor));
const signedTax = (lines: ReadonlyArray<{ kind: string; taxMinor: number }>): number =>
  sum(lines.map((l) => signOf(l) * l.taxMinor));

/** Rândul de reducere din puncte al unei linii de produs: o bucată de serviciu, cu valoarea reducerii și TVA-ul ei. */
function discountLine(input: {
  orderLineId: string;
  title: string;
  unitName: string;
  amountMinor: number;
  taxMinor: number;
  taxRateBps: number;
}): DraftLine {
  return {
    kind: "discount",
    orderLineId: input.orderLineId,
    sku: null,
    title: input.title,
    unitName: input.unitName,
    quantityTicks: ONE_UNIT_TICKS,
    unitPriceMinor: input.amountMinor,
    lineTotalMinor: input.amountMinor,
    netMinor: input.amountMinor - input.taxMinor,
    taxMinor: input.taxMinor,
    taxRateBps: input.taxRateBps,
    dischargeStock: false,
  };
}

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
  const pointsDiscount = sum(order.lines.map((l) => l.loyaltyDiscountMinor ?? 0));
  if (order.discountMinor !== pointsDiscount) {
    // singura reducere de comandă cunoscută e cea din puncte, repartizată pe linii; alta (cupon) nu se ghicește
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
        dischargeStock: line.dischargeable && line.digital !== true,
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
    if (line.loyaltyDiscountMinor) {
      const name = line.variantTitle ? `${line.title} (${line.variantTitle})` : line.title;
      lines.push(
        discountLine({
          orderLineId: line.id,
          title: `${options.labels.pointsDiscount ?? "Reducere"}: ${name}`,
          unitName: options.labels.serviceUnit,
          amountMinor: line.loyaltyDiscountMinor,
          taxMinor: line.loyaltyDiscountTaxMinor ?? 0,
          taxRateBps: line.taxRateBps,
        }),
      );
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

  const totalMinor = signedTotal(lines);
  const taxMinor = signedTax(lines);
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
  // liniile digitale nu au stoc de descărcat: nu influențează bifa, dar nici nu o pot cere singure
  const digitalIds = new Set(order.lines.filter((l) => l.digital === true).map((l) => l.id));
  const stocked = products.filter(
    (l) => !(l.orderLineId !== null && digitalIds.has(l.orderLineId)),
  );
  return {
    lines,
    totalMinor,
    taxMinor,
    useStock: stocked.length > 0 && stocked.every((l) => l.dischargeStock),
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
  /** Valoarea rândului de reducere din puncte al liniei pe factură (Faza 15b). */
  discountMinor?: number;
  /** Denumirea rândului de reducere, ca pe factură. */
  discountTitle?: string;
  discountUnitName?: string;
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
    if (original.discountMinor) {
      // partea de reducere a bucăților stornate: aceeași regulă ca la rambursare (cumulat, ultima bucată ia restul)
      const share = discountShareForReturn({
        lineDiscountMinor: original.discountMinor,
        lineGrossMinor: original.lineTotalMinor,
        grossBeforeMinor: done.lineTotalMinor,
        grossNowMinor: total,
      });
      if (share > 0) {
        lines.push(
          discountLine({
            orderLineId: original.orderLineId,
            title: original.discountTitle ?? original.title,
            unitName: original.discountUnitName ?? original.unitName,
            amountMinor: share,
            taxMinor: vatFromGross(share, original.taxRateBps),
            taxRateBps: original.taxRateBps,
          }),
        );
      }
    }
  }
  return {
    lines,
    totalMinor: signedTotal(lines),
    taxMinor: signedTax(lines),
  };
}

// ---------------------------------------------------------------------------
// Stornoul «total» ca REST nestornat (mini-faza storno-total, decizia 2026-11-23)
// ---------------------------------------------------------------------------

/** O linie a facturii de stornat (produs, transport sau taxă de ramburs), așa cum e înghețată pe documentul emis. */
export interface StornoParentLine {
  kind: DraftLineKind;
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
  // rândul de reducere are aceeași linie de comandă ca produsul: cheia îi ține separați
  const keyOf = (l: { kind: string; orderLineId: string | null }): string =>
    l.kind === "discount" ? `discount:${l.orderLineId}` : (l.orderLineId ?? `kind:${l.kind}`);
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
    const remainingTotal = p.lineTotalMinor - d.lineTotalMinor;
    // rândul de reducere se stornează după VALOARE (fiecare storno are câte «o bucată» din el): rămâne o bucată cât e valoare
    const remainingQty =
      p.kind === "discount"
        ? remainingTotal > 0
          ? p.quantityTicks
          : 0n
        : p.quantityTicks - d.quantityTicks;
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
      unitPriceMinor: p.kind === "discount" ? remainingTotal : p.unitPriceMinor,
      lineTotalMinor: remainingTotal,
      netMinor: untouched ? p.netMinor : remainingTotal - tax,
      taxMinor: tax,
      taxRateBps: p.taxRateBps,
      dischargeStock: false,
    });
  }
  const totalMinor = signedTotal(lines);
  const earlierMinor = signedTotal(earlier);
  const invoiceMinor = signedTotal(parent);
  if (earlierMinor + totalMinor !== invoiceMinor) {
    throw new InvoiceDraftError(
      "INVOICE_TOTAL_MISMATCH",
      `Brutul stornat (${earlierMinor} + ${totalMinor} bani) nu coincide cu brutul facturii (${invoiceMinor} bani)`,
      { earlierMinor, remainderMinor: totalMinor, invoiceMinor },
    );
  }
  return { lines, totalMinor, taxMinor: signedTax(lines) };
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

/**
 * Linia așa cum o cere contractul furnizorului (`InvoiceDocLine`): denumirea și SKU-ul, fără câmpuri interne. Rândul de
 * reducere pleacă cu cantitate și sume cu semn schimbat (preț unitar pozitiv), ca documentul să dea suma de plătit.
 */
export function toDocLines(lines: readonly DraftLine[]): InvoiceDocLine[] {
  return lines.map((l) => ({
    kind: l.kind,
    name: l.title,
    code: l.sku,
    unitName: l.unitName,
    quantityTicks: signOf(l) === 1 ? l.quantityTicks : -l.quantityTicks,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: signOf(l) * l.lineTotalMinor,
    taxMinor: signOf(l) * l.taxMinor,
    taxRateBps: l.taxRateBps,
    dischargeStock: l.dischargeStock,
  }));
}
