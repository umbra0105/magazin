/**
 * Probă de dezvoltare pentru disponibilitatea stocului (Faza 5, punctul 4). Nu atinge baza de date, Redis sau rețeaua:
 * rulează funcțiile PURE din `inventory/availability.ts` și `inventory/reconcile.ts` și tipărește rezultatul.
 *
 *   npm.cmd run dev:availability
 *       tabel cu cele 6 produse-model, la mai multe niveluri de stoc, plus cronologia SmartBill din plan
 *   npm.cmd run dev:availability -- <pas> <stoc> [angajat] [rezervat] [tampon] [da]
 *       un singur caz cu valorile tale (virgulă sau punct), ex.: `-- 41,25 100` sau `-- 0,3 1 0 0 0 da`
 *       (ultimul argument «da» pornește «La comandă» la epuizare)
 */
import { formatQuantity, parseQuantity, subtractQuantity, type Quantity } from "@ecom/shared";
import {
  computeAvailability,
  type Availability,
  type AvailabilityInput,
  type VisibleStockState,
} from "../src/inventory/availability";
import { mirrorDecision, reconcileSnapshot, snapshotFreshness } from "../src/inventory/reconcile";

const LABEL: Record<VisibleStockState, string> = {
  in_stock: "În stoc",
  limited: "Stoc limitat",
  on_order: "La comandă",
  unavailable: "Indisponibil",
};

interface Case {
  step: string;
  physical: string;
  committed?: string;
  reserved?: string;
  buffer?: string;
  allowBackorder?: boolean;
}

function input(c: Case): AvailabilityInput {
  const q = (text: string | undefined): Quantity => parseQuantity(text ?? "0");
  return {
    isDigital: false,
    manageStock: true,
    stockStatus: "instock",
    allowBackorder: c.allowBackorder ?? false,
    step: parseQuantity(c.step),
    inventory: {
      physical: q(c.physical),
      committed: q(c.committed),
      reserved: q(c.reserved),
      safetyBuffer: q(c.buffer),
      lowStockSteps: null,
    },
    defaultLowStockSteps: 2,
    leadTime: { productDays: null, brandDays: null, globalDays: 14 },
  };
}

const show = (value: Quantity | null): string => (value === null ? "—" : formatQuantity(value));

function describe(a: Availability): string {
  const orderable =
    a.orderableSteps === null
      ? "fără limită"
      : `${a.orderableSteps} ${a.orderableSteps === 1n ? "pas" : "pași"}`;
  const extra = [
    a.showCount !== null ? `«mai sunt ${a.showCount}»` : null,
    a.leadTimeDays !== null ? `termen ${a.leadTimeDays} zile` : null,
    a.remainderOnly ? "doar rest nevandabil" : null,
    a.lowStock ? "ALERTĂ stoc mic" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `${LABEL[a.state].padEnd(13)} comandabil: ${orderable}${extra ? `  (${extra})` : ""}`;
}

function line(label: string, c: Case): void {
  const a = computeAvailability(input(c));
  console.log(
    `  stoc ${c.physical.padStart(7)} → ${String(a.availableSteps).padStart(3)} pași, rest ${show(a.remainder).padStart(6)} │ ${describe(a)}   [${label}]`,
  );
}

const args = process.argv.slice(2);
if (args.length >= 2) {
  const [
    step = "1",
    physical = "0",
    committed = "0",
    reserved = "0",
    buffer = "0",
    backorder = "",
  ] = args;
  const c: Case = {
    step,
    physical,
    committed,
    reserved,
    buffer,
    allowBackorder: backorder === "da",
  };
  const a = computeAvailability(input(c));
  console.log(
    `Pas ${step}, fizic ${physical}, angajat ${committed}, rezervat ${reserved}, tampon ${buffer}`,
  );
  console.log(`  Disponibil (fizic − angajat − rezervat): ${show(a.available)}`);
  console.log(`  Vandabil (după tampon):                  ${show(a.sellable)}`);
  console.log(`  Pași întregi: ${a.availableSteps}   Rest nevandabil: ${show(a.remainder)}`);
  console.log(`  Stare vizibilă: ${describe(a)}`);
  process.exit(0);
}

console.log("Cele 6 produse-model (pragul «stoc limitat» = 2 pași, fără tampon):\n");
const products: Array<[string, string, string[]]> = [
  ["Țeavă PVC-U (ml, pas 2,5)", "2,5", ["0", "2,5", "5", "17,5", "40"]],
  ["Liner (mp, rola de 41,25)", "41,25", ["17,5", "41,25", "82,5", "100", "205,5"]],
  ["Bisulfat de sodiu (kg, sacul de 25)", "25", ["10", "25", "50", "80", "200"]],
  ["Furtun de dozare (ml, pas 1)", "1", ["0,5", "1", "2", "10", "100"]],
  ["Mozaic (mp, cutia de 2,03)", "2,03", ["1", "2,03", "6,09", "10", "40"]],
  ["Lemn de abachi (ml, bucata de 1,8)", "1,8", ["1,5", "1,8", "3,6", "10"]],
];
for (const [name, step, stocks] of products) {
  console.log(name);
  for (const physical of stocks) line(`pas ${step}`, { step, physical });
  console.log("");
}

console.log("Tampon, angajat, rezervat și «La comandă» la epuizare (pas 1):");
line("angajat 2, rezervat 1", { step: "1", physical: "5", committed: "2", reserved: "1" });
line("tampon 3", { step: "1", physical: "5", buffer: "3" });
line("epuizat, fără hibrid", { step: "1", physical: "0" });
line("epuizat, cu hibrid", { step: "1", physical: "0", allowBackorder: true });
line("10 × 0,3 pe 1,0", { step: "0,3", physical: "1" });

console.log(
  "\nCronologia din plan: o bucată se scade o singură dată (fereastra de siguranță 30 min)",
);
const day = (hhmm: string): Date => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return new Date(Date.UTC(2026, 9, 21, Number(h), Number(m)));
};
const order = { id: "comanda-1", quantity: parseQuantity("1"), invoicedAt: day("10:01") };
for (const [label, photoAt, smartbill] of [
  ["poza de la 09:00 (înainte de comandă)", "09:00", "5"],
  ["poza de la 10:20 (factura e la 19 min înainte: în fereastră)", "10:20", "4"],
  ["poza de la 12:00 (factura e deja în poză)", "12:00", "3"],
] as const) {
  const result = reconcileSnapshot({
    snapshot: { quantity: parseQuantity(smartbill), takenAt: day(photoAt) },
    safetyWindowMinutes: 30,
    commitments: [order],
    adjustments: [],
  });
  const decision = mirrorDecision(order.invoicedAt, day(photoAt), 30);
  console.log(
    `  ${label}: SmartBill ${smartbill} → fizic ${formatQuantity(result.physical)}, angajat ${formatQuantity(result.committed)} (${decision}) → disponibil ${formatQuantity(
      subtractQuantity(result.physical, result.committed),
    )}`,
  );
}

const now = day("12:00");
for (const [label, takenAt] of [
  ["acum 3 ore", new Date(now.getTime() - 3 * 3_600_000)],
  ["acum 30 de ore", new Date(now.getTime() - 30 * 3_600_000)],
  ["niciodată", null],
] as const) {
  const f = snapshotFreshness(takenAt, now, 24);
  console.log(`  Poza «${label}» → ${f.status}${"ageHours" in f ? ` (${f.ageHours} h)` : ""}`);
}
