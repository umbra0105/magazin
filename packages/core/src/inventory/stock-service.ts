import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@ecom/db";
import {
  MAX_QUANTITY,
  ValidationError,
  addQuantity,
  assertOrderQuantity,
  quantityFromTicks,
  stepsIn,
  type Quantity,
  type QuantityDelta,
} from "@ecom/shared";
import {
  ADJUSTMENT_NOTE_MAX,
  ADJUSTMENT_REASON_LABELS,
  adjustmentSignProblem,
  effectiveAtProblem,
  fitsUnitPrecision,
} from "./adjustment-rules";
import { computeAvailability, type ManagedInventory } from "./availability";
import { ADJUSTMENT_REASONS, LOW_STOCK_STEPS_MAX, type AdjustmentReason } from "./constants";
import { reconcileSnapshot } from "./reconcile";
import { effectiveSaleStep } from "./sale-config";
import { StockError } from "./stock-errors";
import { effectiveMeasureUnit } from "./units";

/**
 * Serviciul de stoc (Faza 5, punctul 5): rezervare, eliberare, confirmare (angajare), angajare directă, oglindire și
 * expirare. Singurul loc care mută contoarele `reserved` / `committed` / `physical` ale `InventoryItem`.
 *
 * Strategia de concurență (detalii în `docs/PROGRESS.md`):
 * 1. orice operație blochează rândurile de stoc implicate cu `SELECT … FOR UPDATE`, într-o singură comandă, ordonate după
 *    `(variantId, warehouseId)` cu `COLLATE "C"`: ordinea de blocare e aceeași peste tot, deci nu există deadlock între
 *    coșuri cu linii în ordine diferită; abia apoi se ating rezervările și angajările (stoc → rezervări/angajări);
 * 2. verificarea disponibilului și scrierea sunt UNA SINGURĂ comandă condiționată
 *    (`… WHERE physical − committed − reserved − safetyBuffer ≥ q`), nu «citesc, apoi scriu»;
 * 3. baza refuză oricum valorile negative (`CHECK`), o a doua rezervare activă pentru aceeași comandă și linie (index
 *    parțial unic) și a doua angajare pentru aceeași comandă și linie (unicitate);
 * 4. fiecare operație pe un coș e O tranzacție: dacă o linie nu încape, nu rămâne nimic pe celelalte;
 * 5. tranzițiile de stare (activă → confirmată / expirată / eliberată) se fac o singură dată, sub blocare, iar contorul se
 *    mișcă doar când tranziția s-a făcut: contoarele rămân egale cu rândurile care le justifică (`checkConsistency`).
 *
 * Produsele digitale, negestionate și cele «La comandă» (hibrid epuizat) nu rezervă și nu se angajează: se raportează ca
 * «skipped_*». Cantitățile trec doar prin `Quantity`.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const TRANSACTION = { maxWait: 15_000, timeout: 30_000 } as const;
const MAX_ATTEMPTS = 3;
const DEFAULT_EXPIRE_BATCH = 200;
const ZERO = 0n as Quantity;

export interface StockRef {
  refType: string;
  refId: string;
}

export interface StockLine {
  variantId: string;
  /** Depozitul; implicit depozitul implicit (D3: o singură locație) */
  warehouseId?: string;
  quantity: Quantity;
}

export type LineOutcomeKind =
  | "reserved"
  | "already_reserved"
  | "committed"
  | "already_committed"
  | "skipped_digital"
  | "skipped_unmanaged"
  | "skipped_on_order";

export interface LineOutcome {
  variantId: string;
  outcome: LineOutcomeKind;
  quantity: Quantity;
}

export interface ApplySnapshotInput {
  variantId: string;
  warehouseId?: string;
  /** Rândul `StockSnapshot` al pozei (mișcările îl referă) */
  snapshotId: string;
  quantity: Quantity;
  takenAt: Date;
  safetyWindowMinutes: number;
}

export type ApplySnapshotResult =
  | { applied: false; reason: "not_newer" }
  | {
      applied: true;
      physical: Quantity;
      physicalClamped: boolean;
      committed: Quantity;
      mirroredIds: string[];
      stillCommittedIds: string[];
    };

/** Ajustare manuală a stocului fizic (inventariere, recepție, vânzare în magazin …). */
export interface AdjustPhysicalInput {
  variantId: string;
  /** Depozitul; implicit depozitul implicit */
  warehouseId?: string;
  /** Variația cu semn, în unitatea variantei (nu are legătură cu pasul de vânzare) */
  delta: QuantityDelta;
  reason: AdjustmentReason;
  /** Text liber, obligatoriu */
  note: string;
  /** Când s-a petrecut cu adevărat; implicit acum. Hotărăște dacă poza următoare o înlocuiește sau o păstrează. */
  effectiveAt?: Date;
  actor?: { id: string; label: string };
}

/**
 * - `effective_before_snapshot`: ora efectivă e cel târziu la ora pozei deja aplicate; dacă evenimentul era deja în
 *   SmartBill la acea poză, e scăzut de două ori până la poza următoare (subvânzare temporară, nu supravânzare).
 * - `below_commitments`: stocul fizic a coborât sub ce e angajat + rezervat (disponibilul devine 0).
 */
export interface SetLowStockStepsInput {
  variantId: string;
  /** Lipsă = depozitul implicit */
  warehouseId?: string;
  /** Pragul propriu în pași (0–1000); `null` = fără prag propriu, se folosește setarea globală */
  steps: number | null;
}

export interface SetLowStockStepsResult {
  variantId: string;
  warehouseId: string;
  before: number | null;
  after: number | null;
}

export type AdjustmentWarning = "effective_before_snapshot" | "below_commitments";

export interface AdjustPhysicalResult {
  variantId: string;
  warehouseId: string;
  movementId: string;
  delta: QuantityDelta;
  physicalBefore: Quantity;
  physicalAfter: Quantity;
  effectiveAt: Date;
  warnings: AdjustmentWarning[];
}

export interface ConsistencyReport {
  ok: boolean;
  reserved: Quantity;
  reservedFromRows: Quantity;
  committed: Quantity;
  committedFromRows: Quantity;
}

interface ItemKey {
  variantId: string;
  warehouseId: string;
}

interface ItemRow extends ItemKey {
  physical: bigint;
  physicalAsOf: Date | null;
  committed: bigint;
  reserved: bigint;
  safetyBuffer: bigint;
  lowStockSteps: number | null;
}

interface Counters {
  physical: bigint;
  committed: bigint;
  reserved: bigint;
}

export interface StockServiceDeps {
  /** Clientul bazei (fiecare operație își face tranzacția) sau o tranzacție deschisă (teste: se folosește SAVEPOINT) */
  db: Db;
  now?: () => Date;
}

const keyId = (k: ItemKey): string => `${k.variantId}\u0000${k.warehouseId}`;

function tupleList(keys: readonly ItemKey[]): Prisma.Sql {
  return Prisma.join(keys.map((k) => Prisma.sql`(${k.variantId}, ${k.warehouseId})`));
}

function assertRef(ref: StockRef): void {
  if (!/^[a-z][a-z0-9_]*$/.test(ref.refType) || ref.refId.trim() === "" || ref.refId.length > 100) {
    throw new ValidationError("Referința comenzii nu este validă");
  }
}

function isRootClient(db: Db): db is PrismaClient {
  return "$transaction" in db;
}

function isRetryable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  return (
    e?.code === "P2034" ||
    e?.code === "40P01" ||
    e?.code === "40001" ||
    /deadlock detected/i.test(message)
  );
}

/** Varianta are stoc gestionat: nu e digitală, iar bifa de pe variantă (dacă există) bate pe cea de pe produs. */
function isManagedVariant(variant: {
  manageStock: boolean | null;
  product: { type: string; manageStock: boolean };
}): boolean {
  return variant.product.type !== "digital" && (variant.manageStock ?? variant.product.manageStock);
}

/** Blochează rândurile de stoc cerute, într-o singură comandă, în ordinea fixă; întoarce rândurile existente. */
async function lockItems(tx: Tx, keys: readonly ItemKey[]): Promise<Map<string, ItemRow>> {
  const unique = [...new Map(keys.map((k) => [keyId(k), k])).values()];
  const found = new Map<string, ItemRow>();
  if (unique.length === 0) return found;
  const rows = await tx.$queryRaw<ItemRow[]>(Prisma.sql`
    SELECT "variantId", "warehouseId", physical, "physicalAsOf", committed, reserved, "safetyBuffer", "lowStockSteps"
    FROM inventory_item
    WHERE ("variantId", "warehouseId") IN (${tupleList(unique)})
    ORDER BY "variantId" COLLATE "C", "warehouseId" COLLATE "C"
    FOR UPDATE`);
  for (const row of rows) found.set(keyId(row), row);
  return found;
}

/** Modifică contoarele unui rând de stoc cu variații semnate; CHECK-urile bazei refuză orice valoare negativă. */
async function adjustCounters(
  tx: Tx,
  key: ItemKey,
  delta: { reserved?: bigint; committed?: bigint },
  now: Date,
): Promise<Counters> {
  const [row] = await tx.$queryRaw<Counters[]>(Prisma.sql`
    UPDATE inventory_item
    SET reserved = reserved + ${delta.reserved ?? 0n}, committed = committed + ${delta.committed ?? 0n}, "updatedAt" = ${now}
    WHERE "variantId" = ${key.variantId} AND "warehouseId" = ${key.warehouseId}
    RETURNING physical, committed, reserved`);
  if (!row) throw new StockError("STOCK_VARIANT_NOT_FOUND", "Rândul de stoc nu există");
  return row;
}

/**
 * Rezervă sau angajează `quantity` DOAR dacă `physical − committed − reserved − safetyBuffer ≥ quantity`, într-o singură
 * comandă. `null` = nu încape (nimic modificat).
 */
async function claim(
  tx: Tx,
  key: ItemKey,
  quantity: Quantity,
  column: "reserved" | "committed",
  now: Date,
): Promise<Counters | null> {
  const set =
    column === "reserved"
      ? Prisma.sql`reserved = reserved + ${quantity}`
      : Prisma.sql`committed = committed + ${quantity}`;
  const [row] = await tx.$queryRaw<Counters[]>(Prisma.sql`
    UPDATE inventory_item
    SET ${set}, "updatedAt" = ${now}
    WHERE "variantId" = ${key.variantId} AND "warehouseId" = ${key.warehouseId}
      AND physical - committed - reserved - "safetyBuffer" >= ${quantity}
    RETURNING physical, committed, reserved`);
  return row ?? null;
}

/** Eliberează rezervările active expirate ale rândurilor date (sub blocarea lor). Întoarce câte s-au eliberat. */
async function sweepExpired(tx: Tx, keys: readonly ItemKey[], now: Date): Promise<number> {
  if (keys.length === 0) return 0;
  const rows = await tx.$queryRaw<Array<ItemKey & { quantity: bigint }>>(Prisma.sql`
    UPDATE stock_reservation
    SET status = 'expired', "releasedAt" = ${now}, "updatedAt" = ${now}
    WHERE status = 'active' AND "expiresAt" <= ${now} AND ("variantId", "warehouseId") IN (${tupleList(keys)})
    RETURNING "variantId", "warehouseId", quantity`);
  const sums = new Map<string, { key: ItemKey; sum: bigint }>();
  for (const row of rows) {
    const id = keyId(row);
    const entry = sums.get(id) ?? {
      key: { variantId: row.variantId, warehouseId: row.warehouseId },
      sum: 0n,
    };
    entry.sum += row.quantity;
    sums.set(id, entry);
  }
  for (const { key, sum } of sums.values()) await adjustCounters(tx, key, { reserved: -sum }, now);
  return rows.length;
}

interface Prepared {
  key: ItemKey;
  variantId: string;
  sku: string;
  kind: "managed" | "digital" | "unmanaged";
  quantity: Quantity;
  step: Quantity;
  minSteps: number | null;
  allowBackorder: boolean;
}

interface Shortage {
  variantId: string;
  sku: string;
  requestedSteps: string;
  maxSteps: string;
}

export class StockService {
  constructor(private readonly deps: StockServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** O tranzacție (cu reîncercare la deadlock/conflict) sau, pe un client de tranzacție, un SAVEPOINT. */
  private async atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const db = this.deps.db;
    if (isRootClient(db)) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await db.$transaction(fn, TRANSACTION);
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    }
    const inner = db as Tx;
    const savepoint = `sp_${randomUUID().replaceAll("-", "")}`;
    await inner.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(inner);
      await inner.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await inner.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await inner.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  private async defaultWarehouseId(tx: Tx): Promise<string> {
    const warehouse = await tx.warehouse.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });
    if (!warehouse) throw new StockError("STOCK_NO_WAREHOUSE", "Nu există un depozit implicit");
    return warehouse.id;
  }

  /**
   * Validează liniile ÎNAINTE de orice scriere: depozit, variantă existentă, clasificare (digital / negestionat /
   * gestionat) și, la cele gestionate, cantitate pozitivă, multiplu de pas și ≥ minim. Liniile repetate se adună.
   */
  private async prepare(
    tx: Tx,
    lines: readonly StockLine[],
  ): Promise<{ order: string[]; prepared: Map<string, Prepared> }> {
    if (lines.length === 0) throw new ValidationError("Coșul nu are nicio linie");
    const fallback = lines.some((l) => !l.warehouseId) ? await this.defaultWarehouseId(tx) : "";
    const merged = new Map<string, { key: ItemKey; quantity: Quantity }>();
    const order: string[] = [];
    for (const line of lines) {
      const key = { variantId: line.variantId, warehouseId: line.warehouseId ?? fallback };
      const id = keyId(key);
      order.push(id);
      const existing = merged.get(id);
      merged.set(id, {
        key,
        quantity: existing ? addQuantity(existing.quantity, line.quantity) : line.quantity,
      });
    }

    const variants = await tx.productVariant.findMany({
      where: { id: { in: [...new Set(lines.map((l) => l.variantId))] } },
      select: {
        id: true,
        sku: true,
        manageStock: true,
        saleStep: true,
        minSteps: true,
        product: {
          select: {
            type: true,
            manageStock: true,
            allowBackorder: true,
            saleStep: true,
            minSteps: true,
          },
        },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    const prepared = new Map<string, Prepared>();
    for (const [id, { key, quantity }] of merged) {
      const variant = byId.get(key.variantId);
      if (!variant) {
        throw new StockError(
          "STOCK_VARIANT_NOT_FOUND",
          "Una dintre variantele din coș nu mai există",
          {
            variantId: key.variantId,
          },
        );
      }
      const kind =
        variant.product.type === "digital"
          ? "digital"
          : (variant.manageStock ?? variant.product.manageStock)
            ? "managed"
            : "unmanaged";
      const step = quantityFromTicks(effectiveSaleStep(variant.saleStep, variant.product.saleStep));
      const minSteps = variant.minSteps ?? variant.product.minSteps;
      if (kind === "managed") assertOrderQuantity(quantity, { step, minSteps });
      prepared.set(id, {
        key,
        variantId: key.variantId,
        sku: variant.sku,
        kind,
        quantity,
        step,
        minSteps,
        allowBackorder: variant.product.allowBackorder,
      });
    }
    return { order, prepared };
  }

  private skipOutcome(line: Prepared): LineOutcome | null {
    if (line.kind === "digital") {
      return { variantId: line.variantId, outcome: "skipped_digital", quantity: line.quantity };
    }
    if (line.kind === "unmanaged") {
      return { variantId: line.variantId, outcome: "skipped_unmanaged", quantity: line.quantity };
    }
    return null;
  }

  /** Cât ar mai fi comandabil pe linie și dacă linia devine «La comandă» (hibrid epuizat). */
  private shortage(
    line: Prepared,
    row: ItemRow | undefined,
  ): { onOrder: boolean; shortage: Shortage } {
    const inventory: ManagedInventory | null = row
      ? {
          physical: quantityFromTicks(row.physical),
          committed: quantityFromTicks(row.committed),
          reserved: quantityFromTicks(row.reserved),
          safetyBuffer: quantityFromTicks(row.safetyBuffer),
          lowStockSteps: row.lowStockSteps,
        }
      : null;
    const availability = computeAvailability({
      isDigital: false,
      manageStock: true,
      stockStatus: "instock",
      allowBackorder: line.allowBackorder,
      step: line.step,
      minSteps: line.minSteps,
      inventory,
      // pragul și termenul nu influențează decizia «încape / La comandă»
      defaultLowStockSteps: 2,
      leadTime: { productDays: null, brandDays: null, globalDays: 14 },
    });
    return {
      onOrder: availability.state === "on_order",
      shortage: {
        variantId: line.variantId,
        sku: line.sku,
        requestedSteps: stepsIn(line.quantity, line.step).toString(),
        maxSteps: (availability.orderableSteps ?? 0n).toString(),
      },
    };
  }

  private insufficient(shortages: readonly Shortage[]): StockError {
    const listed = shortages
      .map((s) => `${s.sku} (cerut ${s.requestedSteps}, disponibil ${s.maxSteps}, în pași)`)
      .join("; ");
    return new StockError("STOCK_INSUFFICIENT", `Stoc insuficient: ${listed}`, {
      lines: shortages,
    });
  }

  private async readRow(db: Db, key: ItemKey): Promise<ItemRow | undefined> {
    const [row] = await db.$queryRaw<ItemRow[]>(Prisma.sql`
      SELECT "variantId", "warehouseId", physical, "physicalAsOf", committed, reserved, "safetyBuffer", "lowStockSteps"
      FROM inventory_item WHERE "variantId" = ${key.variantId} AND "warehouseId" = ${key.warehouseId}`);
    return row;
  }

  private async movement(
    tx: Tx,
    data: {
      key: ItemKey;
      kind: "commit" | "release" | "mirror" | "snapshot" | "adjustment";
      deltaPhysical?: bigint;
      deltaCommitted?: bigint;
      after: Counters;
      ref?: StockRef;
      snapshotId?: string;
      effectiveAt: Date;
      reason?: AdjustmentReason;
      note?: string;
      actor?: { id: string; label: string };
    },
  ): Promise<string> {
    const created = await tx.stockMovement.create({
      select: { id: true },
      data: {
        variantId: data.key.variantId,
        warehouseId: data.key.warehouseId,
        kind: data.kind,
        deltaPhysical: data.deltaPhysical ?? 0n,
        deltaCommitted: data.deltaCommitted ?? 0n,
        physicalAfter: data.after.physical,
        committedAfter: data.after.committed,
        effectiveAt: data.effectiveAt,
        ...(data.ref && { refType: data.ref.refType, refId: data.ref.refId }),
        ...(data.snapshotId && { snapshotId: data.snapshotId }),
        ...(data.reason && { reason: data.reason }),
        ...(data.note !== undefined && { note: data.note }),
        ...(data.actor && { actorId: data.actor.id, actorLabel: data.actor.label }),
      },
    });
    return created.id;
  }

  /** Angajarea există deja pentru comandă și linie? Eliberată = comanda anulată, nu se mai angajează. */
  private async existingCommitment(
    tx: Tx,
    key: ItemKey,
    ref: StockRef,
  ): Promise<"none" | "present"> {
    const found = await tx.stockCommitment.findFirst({
      where: {
        refType: ref.refType,
        refId: ref.refId,
        variantId: key.variantId,
        warehouseId: key.warehouseId,
      },
      select: { status: true },
    });
    if (!found) return "none";
    if (found.status === "released") {
      throw new StockError(
        "STOCK_COMMITMENT_RELEASED",
        "Comanda a fost anulată: stocul ei a fost eliberat și nu se mai poate angaja",
        { variantId: key.variantId },
      );
    }
    return "present";
  }

  // -------------------------------------------------------------------------------------------------------------

  /**
   * Rezervă TOATE liniile coșului (card: la inițierea plății) sau nimic. Idempotent pe `ref`: aceeași comandă, aceleași
   * cantități → `already_reserved`; alte cantități → `STOCK_RESERVATION_MISMATCH`.
   */
  async reserve(
    ref: StockRef,
    lines: readonly StockLine[],
    expiresAt: Date,
  ): Promise<LineOutcome[]> {
    assertRef(ref);
    if (Number.isNaN(expiresAt.getTime()))
      throw new ValidationError("Ora de expirare nu este validă");
    return this.atomic(async (tx) => {
      const now = this.now();
      const { order, prepared } = await this.prepare(tx, lines);
      const managed = [...prepared.values()].filter((p) => p.kind === "managed");
      const locked = await lockItems(
        tx,
        managed.map((p) => p.key),
      );
      await sweepExpired(tx, [...locked.values()], now);

      const results = new Map<string, LineOutcome>();
      const shortages: Shortage[] = [];
      // în ordinea blocării (identică pentru toate tranzacțiile)
      const ordered = [...locked.keys()]
        .map((id) => prepared.get(id))
        .filter((p): p is Prepared => p !== undefined)
        .concat(managed.filter((p) => !locked.has(keyId(p.key))));
      for (const line of ordered) {
        const id = keyId(line.key);
        const existing = await tx.stockReservation.findFirst({
          where: {
            refType: ref.refType,
            refId: ref.refId,
            variantId: line.variantId,
            warehouseId: line.key.warehouseId,
            status: { in: ["active", "confirmed"] },
          },
        });
        if (existing) {
          if (existing.quantity !== line.quantity) {
            throw new StockError(
              "STOCK_RESERVATION_MISMATCH",
              "Aceeași comandă a cerut altă cantitate pentru aceeași linie",
              { variantId: line.variantId },
            );
          }
          results.set(id, {
            variantId: line.variantId,
            outcome: "already_reserved",
            quantity: line.quantity,
          });
          continue;
        }
        const claimed = await claim(tx, line.key, line.quantity, "reserved", now);
        if (!claimed) {
          const { onOrder, shortage } = this.shortage(line, await this.readRow(tx, line.key));
          if (onOrder) {
            results.set(id, {
              variantId: line.variantId,
              outcome: "skipped_on_order",
              quantity: line.quantity,
            });
          } else {
            shortages.push(shortage);
          }
          continue;
        }
        await tx.stockReservation.create({
          data: {
            variantId: line.variantId,
            warehouseId: line.key.warehouseId,
            quantity: line.quantity,
            status: "active",
            refType: ref.refType,
            refId: ref.refId,
            expiresAt,
          },
        });
        results.set(id, {
          variantId: line.variantId,
          outcome: "reserved",
          quantity: line.quantity,
        });
      }
      if (shortages.length > 0) throw this.insufficient(shortages);

      return order.map((id) => {
        const prep = prepared.get(id) as Prepared;
        return results.get(id) ?? (this.skipOutcome(prep) as LineOutcome);
      });
    });
  }

  /** Eliberează rezervările ACTIVE ale comenzii (plată eșuată / anulată). Întoarce câte s-au eliberat; idempotent. */
  async release(ref: StockRef): Promise<number> {
    assertRef(ref);
    return this.atomic(async (tx) => {
      const now = this.now();
      const seen = await tx.stockReservation.findMany({
        where: { refType: ref.refType, refId: ref.refId, status: "active" },
        select: { variantId: true, warehouseId: true },
      });
      if (seen.length === 0) return 0;
      await lockItems(tx, seen);
      const rows = await tx.$queryRaw<Array<ItemKey & { quantity: bigint }>>(Prisma.sql`
        UPDATE stock_reservation
        SET status = 'released', "releasedAt" = ${now}, "updatedAt" = ${now}
        WHERE "refType" = ${ref.refType} AND "refId" = ${ref.refId} AND status = 'active'
        RETURNING "variantId", "warehouseId", quantity`);
      for (const row of rows) await adjustCounters(tx, row, { reserved: -row.quantity }, now);
      return rows.length;
    });
  }

  /**
   * Plata confirmată: rezervarea devine angajare. Idempotentă (webhook dublu). O rezervare expirată sau eliberată se
   * reia dacă stocul încă există (plată târzie), altfel `STOCK_RESERVATION_LOST` și nimic nu se modifică.
   */
  async confirmReservation(ref: StockRef): Promise<LineOutcome[]> {
    assertRef(ref);
    return this.atomic(async (tx) => {
      const now = this.now();
      const seen = await tx.stockReservation.findMany({
        where: { refType: ref.refType, refId: ref.refId },
        select: { variantId: true, warehouseId: true },
      });
      if (seen.length === 0) return [];
      const locked = await lockItems(tx, seen);
      const rows = await tx.stockReservation.findMany({
        where: { refType: ref.refType, refId: ref.refId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const outcomes: LineOutcome[] = [];
      for (const id of locked.keys()) {
        const own = rows.filter((r) => keyId(r) === id);
        const key: ItemKey = { variantId: own[0]!.variantId, warehouseId: own[0]!.warehouseId };
        const confirmed = own.find((r) => r.status === "confirmed");
        const active = own.find((r) => r.status === "active");
        const latest = own[0]!;
        const quantity = quantityFromTicks((confirmed ?? active ?? latest).quantity);

        if ((await this.existingCommitment(tx, key, ref)) === "present") {
          // angajarea există deja: dacă mai e o rezervare activă, doar se închide
          if (active) {
            await tx.stockReservation.updateMany({
              where: { id: active.id, status: "active" },
              data: { status: "confirmed", confirmedAt: now },
            });
            await adjustCounters(tx, key, { reserved: -active.quantity }, now);
          }
          outcomes.push({ variantId: key.variantId, outcome: "already_committed", quantity });
          continue;
        }

        let after: Counters;
        if (active) {
          await tx.stockReservation.updateMany({
            where: { id: active.id, status: "active" },
            data: { status: "confirmed", confirmedAt: now },
          });
          after = await adjustCounters(
            tx,
            key,
            { reserved: -active.quantity, committed: active.quantity },
            now,
          );
        } else {
          // expirată sau eliberată (sau «confirmed» fără angajare): se reia cantitatea, dacă încape
          const claimed = await claim(tx, key, quantity, "committed", now);
          if (!claimed) {
            throw new StockError(
              "STOCK_RESERVATION_LOST",
              "Rezervarea a expirat și stocul nu mai este disponibil: plata trebuie rambursată",
              { variantId: key.variantId },
            );
          }
          after = claimed;
        }
        await tx.stockCommitment.create({
          data: {
            variantId: key.variantId,
            warehouseId: key.warehouseId,
            quantity,
            status: "open",
            refType: ref.refType,
            refId: ref.refId,
            committedAt: now,
          },
        });
        await this.movement(tx, {
          key,
          kind: "commit",
          deltaCommitted: quantity,
          after,
          ref,
          effectiveAt: now,
        });
        outcomes.push({ variantId: key.variantId, outcome: "committed", quantity });
      }
      return outcomes;
    });
  }

  /** Angajare fără rezervare (ramburs: scade imediat la plasare). Idempotentă pe `ref`; tot-sau-nimic. */
  async commitDirect(ref: StockRef, lines: readonly StockLine[]): Promise<LineOutcome[]> {
    assertRef(ref);
    return this.atomic(async (tx) => {
      const now = this.now();
      const { order, prepared } = await this.prepare(tx, lines);
      const managed = [...prepared.values()].filter((p) => p.kind === "managed");
      const locked = await lockItems(
        tx,
        managed.map((p) => p.key),
      );
      await sweepExpired(tx, [...locked.values()], now);
      const results = new Map<string, LineOutcome>();
      const shortages: Shortage[] = [];
      const ordered = [...locked.keys()]
        .map((id) => prepared.get(id))
        .filter((p): p is Prepared => p !== undefined)
        .concat(managed.filter((p) => !locked.has(keyId(p.key))));
      for (const line of ordered) {
        const id = keyId(line.key);
        if ((await this.existingCommitment(tx, line.key, ref)) === "present") {
          results.set(id, {
            variantId: line.variantId,
            outcome: "already_committed",
            quantity: line.quantity,
          });
          continue;
        }
        const claimed = await claim(tx, line.key, line.quantity, "committed", now);
        if (!claimed) {
          const { onOrder, shortage } = this.shortage(line, await this.readRow(tx, line.key));
          if (onOrder) {
            results.set(id, {
              variantId: line.variantId,
              outcome: "skipped_on_order",
              quantity: line.quantity,
            });
          } else {
            shortages.push(shortage);
          }
          continue;
        }
        await tx.stockCommitment.create({
          data: {
            variantId: line.variantId,
            warehouseId: line.key.warehouseId,
            quantity: line.quantity,
            status: "open",
            refType: ref.refType,
            refId: ref.refId,
            committedAt: now,
          },
        });
        await this.movement(tx, {
          key: line.key,
          kind: "commit",
          deltaCommitted: line.quantity,
          after: claimed,
          ref,
          effectiveAt: now,
        });
        results.set(id, {
          variantId: line.variantId,
          outcome: "committed",
          quantity: line.quantity,
        });
      }
      if (shortages.length > 0) throw this.insufficient(shortages);
      return order.map((id) => {
        const prep = prepared.get(id) as Prepared;
        return results.get(id) ?? (this.skipOutcome(prep) as LineOutcome);
      });
    });
  }

  /**
   * Comanda anulată înainte de oglindire: angajările DESCHISE se eliberează (o dată). Cele deja oglindite nu se ating:
   * stocul revine prin stornoul din SmartBill.
   */
  async releaseCommitment(ref: StockRef): Promise<{ released: number; alreadyMirrored: number }> {
    assertRef(ref);
    return this.atomic(async (tx) => {
      const now = this.now();
      const seen = await tx.stockCommitment.findMany({
        where: { refType: ref.refType, refId: ref.refId },
        select: { variantId: true, warehouseId: true },
      });
      if (seen.length === 0) return { released: 0, alreadyMirrored: 0 };
      await lockItems(tx, seen);
      const rows = await tx.stockCommitment.findMany({
        where: { refType: ref.refType, refId: ref.refId },
        orderBy: { id: "asc" },
      });
      let released = 0;
      let alreadyMirrored = 0;
      for (const row of rows) {
        if (row.status === "mirrored") alreadyMirrored++;
        if (row.status !== "open") continue;
        const moved = await tx.stockCommitment.updateMany({
          where: { id: row.id, status: "open" },
          data: { status: "released", releasedAt: now },
        });
        if (moved.count !== 1) continue;
        const key = { variantId: row.variantId, warehouseId: row.warehouseId };
        const after = await adjustCounters(tx, key, { committed: -row.quantity }, now);
        await this.movement(tx, {
          key,
          kind: "release",
          deltaCommitted: -row.quantity,
          after,
          ref,
          effectiveAt: now,
        });
        released++;
      }
      return { released, alreadyMirrored };
    });
  }

  /** Marchează ora facturii pe angajările deschise ale comenzii (o singură dată). Sub aceeași blocare ca poza. */
  async markInvoiced(ref: StockRef, invoicedAt: Date): Promise<number> {
    assertRef(ref);
    if (Number.isNaN(invoicedAt.getTime()))
      throw new ValidationError("Ora facturii nu este validă");
    return this.atomic(async (tx) => {
      const seen = await tx.stockCommitment.findMany({
        where: { refType: ref.refType, refId: ref.refId, status: "open" },
        select: { variantId: true, warehouseId: true },
      });
      if (seen.length === 0) return 0;
      await lockItems(tx, seen);
      const result = await tx.stockCommitment.updateMany({
        where: { refType: ref.refType, refId: ref.refId, status: "open", invoicedAt: null },
        data: { invoicedAt },
      });
      return result.count;
    });
  }

  /**
   * Aplică poza SmartBill pe un rând de stoc: fizicul devine poza plus ajustările cu ora efectivă după ea; angajările pe
   * care poza le conține devin «oglindite» (nu se mai scad a doua oară). O poză mai veche sau identică cu ultima aplicată
   * se ignoră. Creează rândul de stoc dacă lipsește.
   */
  async applySnapshot(input: ApplySnapshotInput): Promise<ApplySnapshotResult> {
    return this.atomic(async (tx) => {
      const now = this.now();
      const warehouseId = input.warehouseId ?? (await this.defaultWarehouseId(tx));
      const key: ItemKey = { variantId: input.variantId, warehouseId };
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO inventory_item (id, "variantId", "warehouseId", "updatedAt")
        VALUES (${randomUUID()}, ${key.variantId}, ${key.warehouseId}, ${now})
        ON CONFLICT ("variantId", "warehouseId") DO NOTHING`);
      const row = (await lockItems(tx, [key])).get(keyId(key));
      if (!row) throw new StockError("STOCK_VARIANT_NOT_FOUND", "Rândul de stoc nu există");
      if (row.physicalAsOf && input.takenAt.getTime() <= row.physicalAsOf.getTime()) {
        return { applied: false as const, reason: "not_newer" as const };
      }

      const commitments = await tx.stockCommitment.findMany({
        where: { variantId: key.variantId, warehouseId, status: "open" },
        orderBy: [{ committedAt: "asc" }, { id: "asc" }],
      });
      const adjustments = await tx.stockMovement.findMany({
        where: {
          variantId: key.variantId,
          warehouseId,
          kind: "adjustment",
          effectiveAt: { gt: input.takenAt },
        },
        select: { effectiveAt: true, deltaPhysical: true },
      });
      const result = reconcileSnapshot({
        snapshot: { quantity: input.quantity, takenAt: input.takenAt },
        safetyWindowMinutes: input.safetyWindowMinutes,
        commitments: commitments.map((c) => ({
          id: c.id,
          quantity: quantityFromTicks(c.quantity),
          invoicedAt: c.invoicedAt,
        })),
        adjustments: adjustments.map((a) => ({
          effectiveAt: a.effectiveAt,
          delta: a.deltaPhysical as QuantityDelta,
        })),
      });

      const mirrored = commitments.filter((c) => result.mirroredIds.includes(c.id));
      const mirroredTotal = mirrored.reduce((sum, c) => sum + c.quantity, 0n);
      const [after] = await tx.$queryRaw<Counters[]>(Prisma.sql`
        UPDATE inventory_item
        SET physical = ${result.physical}, "physicalAsOf" = ${input.takenAt},
            committed = committed - ${mirroredTotal}, "updatedAt" = ${now}
        WHERE "variantId" = ${key.variantId} AND "warehouseId" = ${warehouseId}
        RETURNING physical, committed, reserved`);
      if (!after) throw new StockError("STOCK_VARIANT_NOT_FOUND", "Rândul de stoc nu există");

      if (mirrored.length > 0) {
        await tx.stockCommitment.updateMany({
          where: { id: { in: mirrored.map((c) => c.id) }, status: "open" },
          data: { status: "mirrored", mirroredAt: now },
        });
      }
      const physicalDelta = result.physical - row.physical;
      if (physicalDelta !== 0n) {
        await this.movement(tx, {
          key,
          kind: "snapshot",
          deltaPhysical: physicalDelta,
          after: { physical: after.physical, committed: row.committed, reserved: after.reserved },
          snapshotId: input.snapshotId,
          effectiveAt: input.takenAt,
        });
      }
      let running = row.committed;
      for (const c of mirrored) {
        running -= c.quantity;
        await this.movement(tx, {
          key,
          kind: "mirror",
          deltaCommitted: -c.quantity,
          after: { physical: after.physical, committed: running, reserved: after.reserved },
          ref: { refType: c.refType, refId: c.refId },
          effectiveAt: now,
        });
      }
      return {
        applied: true as const,
        physical: result.physical,
        physicalClamped: result.physicalClamped,
        committed: quantityFromTicks(after.committed),
        mirroredIds: result.mirroredIds,
        stillCommittedIds: result.stillCommittedIds,
      };
    });
  }

  /**
   * Ajustare manuală a stocului FIZIC cu ora efectivă (D8, D1.4). Se aplică imediat (rândul blocat, o singură comandă
   * condiționată, mișcare imuabilă în registru); ora efectivă hotărăște doar soarta ei la poza următoare: o poză
   * înlocuiește ajustările cu ora cel târziu la ora ei și le păstrează pe cele de după (`applySnapshot`).
   *
   * Reguli: motiv fix + text liber obligatoriu; semnul cerut de motiv; precizia unității (zecimalele ei), NU pasul de
   * vânzare; stocul nu coboară sub 0 și nu trece de plafon; ora efectivă nu e în viitor (peste toleranță). Doar variante
   * gestionate (rândul de stoc se creează la prima ajustare). Nimic nu se modifică la refuz.
   */
  async adjustPhysical(input: AdjustPhysicalInput): Promise<AdjustPhysicalResult> {
    const now = this.now();
    const effectiveAt = input.effectiveAt ?? now;
    if (!(ADJUSTMENT_REASONS as readonly string[]).includes(input.reason)) {
      throw new StockError("STOCK_ADJUSTMENT_INVALID_REASON", "Motivul ajustării nu este valid", {
        reason: input.reason,
      });
    }
    const note = input.note.trim();
    if (note === "") {
      throw new StockError(
        "STOCK_ADJUSTMENT_NOTE_REQUIRED",
        "Textul ajustării e obligatoriu: scrie pe scurt ce s-a întâmplat",
      );
    }
    if (note.length > ADJUSTMENT_NOTE_MAX) {
      throw new StockError(
        "STOCK_ADJUSTMENT_NOTE_TOO_LONG",
        `Textul ajustării are cel mult ${ADJUSTMENT_NOTE_MAX} de caractere`,
        { max: ADJUSTMENT_NOTE_MAX },
      );
    }
    if (input.delta === 0n) {
      throw new StockError(
        "STOCK_ADJUSTMENT_ZERO",
        "Ajustarea trebuie să schimbe stocul (nu poate fi 0)",
      );
    }
    const signProblem = adjustmentSignProblem(input.reason, input.delta);
    if (signProblem) {
      const label = ADJUSTMENT_REASON_LABELS[input.reason];
      throw new StockError(
        "STOCK_ADJUSTMENT_WRONG_SIGN",
        signProblem === "must_decrease"
          ? `«${label}» scade stocul: introdu o cantitate negativă`
          : `«${label}» adaugă în stoc: introdu o cantitate pozitivă`,
        { reason: input.reason, required: signProblem },
      );
    }
    const timeProblem = effectiveAtProblem(effectiveAt, now);
    if (timeProblem === "invalid") {
      throw new StockError("STOCK_ADJUSTMENT_INVALID_TIME", "Ora efectivă nu este o dată validă");
    }
    if (timeProblem === "future") {
      throw new StockError(
        "STOCK_ADJUSTMENT_FUTURE",
        "Ora efectivă nu poate fi în viitor: alege momentul real al evenimentului",
      );
    }

    return this.atomic(async (tx) => {
      const warehouseId = input.warehouseId ?? (await this.defaultWarehouseId(tx));
      const key: ItemKey = { variantId: input.variantId, warehouseId };
      const variant = await tx.productVariant.findUnique({
        where: { id: key.variantId },
        select: {
          manageStock: true,
          measureUnit: { select: { decimals: true } },
          product: {
            select: {
              type: true,
              manageStock: true,
              measureUnit: { select: { decimals: true } },
            },
          },
        },
      });
      if (!variant) {
        throw new StockError("STOCK_VARIANT_NOT_FOUND", "Varianta nu există", {
          variantId: key.variantId,
        });
      }
      if (!isManagedVariant(variant)) {
        throw new StockError(
          "STOCK_NOT_MANAGED",
          "Produsul nu are stoc gestionat: pornește gestionarea stocului înainte să ajustezi cantitatea",
          { variantId: key.variantId },
        );
      }
      // o unitate nulă înseamnă «buc» (fără zecimale), fără a căuta vreun rând «buc» în bază
      const { decimals } = effectiveMeasureUnit(variant.measureUnit, variant.product.measureUnit, {
        decimals: 0,
      });
      if (!fitsUnitPrecision(input.delta, decimals)) {
        throw new StockError(
          "STOCK_ADJUSTMENT_PRECISION",
          decimals === 0
            ? "Unitatea acestui produs nu are zecimale: introdu o cantitate întreagă"
            : `Unitatea acestui produs are cel mult ${decimals} ${decimals === 1 ? "zecimală" : "zecimale"}`,
          { decimals },
        );
      }
      if (!(await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true } }))) {
        throw new StockError("STOCK_NO_WAREHOUSE", "Depozitul nu există", { warehouseId });
      }

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO inventory_item (id, "variantId", "warehouseId", "updatedAt")
        VALUES (${randomUUID()}, ${key.variantId}, ${key.warehouseId}, ${now})
        ON CONFLICT ("variantId", "warehouseId") DO NOTHING`);
      const row = (await lockItems(tx, [key])).get(keyId(key));
      if (!row) throw new StockError("STOCK_VARIANT_NOT_FOUND", "Rândul de stoc nu există");

      // a doua gardă: variația se aplică DOAR dacă rezultatul rămâne în [0, plafon], într-o singură comandă
      const [after] = await tx.$queryRaw<Counters[]>(Prisma.sql`
        UPDATE inventory_item
        SET physical = physical + ${input.delta}, "updatedAt" = ${now}
        WHERE "variantId" = ${key.variantId} AND "warehouseId" = ${key.warehouseId}
          AND physical + ${input.delta} >= 0 AND physical + ${input.delta} <= ${MAX_QUANTITY}
        RETURNING physical, committed, reserved`);
      if (!after) {
        if (row.physical + input.delta < 0n) {
          throw new StockError(
            "STOCK_ADJUSTMENT_BELOW_ZERO",
            "Stocul nu poate deveni negativ: ajustarea scade mai mult decât există",
            { available: row.physical.toString(), requested: input.delta.toString() },
          );
        }
        throw new StockError(
          "STOCK_ADJUSTMENT_OVERFLOW",
          "Ajustarea depășește cantitatea maximă care se poate ține în stoc",
          { available: row.physical.toString(), requested: input.delta.toString() },
        );
      }

      const movementId = await this.movement(tx, {
        key,
        kind: "adjustment",
        deltaPhysical: input.delta,
        after,
        effectiveAt,
        reason: input.reason,
        note,
        ...(input.actor && { actor: input.actor }),
      });

      const warnings: AdjustmentWarning[] = [];
      if (row.physicalAsOf && effectiveAt.getTime() <= row.physicalAsOf.getTime()) {
        warnings.push("effective_before_snapshot");
      }
      if (after.physical < after.committed + after.reserved) warnings.push("below_commitments");
      return {
        variantId: key.variantId,
        warehouseId,
        movementId,
        delta: input.delta,
        physicalBefore: quantityFromTicks(row.physical),
        physicalAfter: quantityFromTicks(after.physical),
        effectiveAt,
        warnings,
      };
    });
  }

  /**
   * Pragul «stoc mic» propriu al unei variante, în PAȘI (D7), pe rândul de stoc al unui depozit. Nu mută nicio cantitate și
   * nu scrie în registrul de mișcări (nu e o mișcare de stoc). Doar variante gestionate; rândul de stoc se creează dacă lipsește
   * (varianta e încă neinventariată), ca pragul să se poată seta înainte de prima ajustare. `steps: null` șterge pragul propriu
   * (revine la setarea globală). Rândul se blochează ca la orice altă operație, deci nu se pierde nicio ajustare simultană.
   */
  async setLowStockSteps(input: SetLowStockStepsInput): Promise<SetLowStockStepsResult> {
    const { steps } = input;
    if (steps !== null && (!Number.isInteger(steps) || steps < 0 || steps > LOW_STOCK_STEPS_MAX)) {
      throw new StockError(
        "STOCK_THRESHOLD_INVALID",
        `Pragul «stoc mic» trebuie să fie un număr întreg de pași între 0 și ${LOW_STOCK_STEPS_MAX}, sau gol`,
        { steps },
      );
    }
    const now = this.now();
    return this.atomic(async (tx) => {
      const warehouseId = input.warehouseId ?? (await this.defaultWarehouseId(tx));
      const key: ItemKey = { variantId: input.variantId, warehouseId };
      const variant = await tx.productVariant.findUnique({
        where: { id: key.variantId },
        select: { manageStock: true, product: { select: { type: true, manageStock: true } } },
      });
      if (!variant) {
        throw new StockError("STOCK_VARIANT_NOT_FOUND", "Varianta nu există", {
          variantId: key.variantId,
        });
      }
      if (!isManagedVariant(variant)) {
        throw new StockError(
          "STOCK_NOT_MANAGED",
          "Produsul nu are stoc gestionat: pornește gestionarea stocului înainte să setezi pragul",
          { variantId: key.variantId },
        );
      }
      if (!(await tx.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true } }))) {
        throw new StockError("STOCK_NO_WAREHOUSE", "Depozitul nu există", { warehouseId });
      }
      // un prag nou are nevoie de rând; ștergerea unui prag care nu există nu creează nimic
      if (steps !== null) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO inventory_item (id, "variantId", "warehouseId", "updatedAt")
          VALUES (${randomUUID()}, ${key.variantId}, ${key.warehouseId}, ${now})
          ON CONFLICT ("variantId", "warehouseId") DO NOTHING`);
      }
      const row = (await lockItems(tx, [key])).get(keyId(key));
      if (!row) return { variantId: key.variantId, warehouseId, before: null, after: null };
      if (row.lowStockSteps !== steps) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE inventory_item
          SET "lowStockSteps" = ${steps}, "updatedAt" = ${now}
          WHERE "variantId" = ${key.variantId} AND "warehouseId" = ${key.warehouseId}`);
      }
      return { variantId: key.variantId, warehouseId, before: row.lowStockSteps, after: steps };
    });
  }

  /**
   * Jobul de expirare: eliberează rezervările active a căror oră a trecut, un rând de stoc pe tranzacție. Idempotent și
   * sigur la rulări simultane. `variantIds` restrânge la anumite variante.
   *
   * Întoarce `expired` (rezervări eliberate de acest apel), `items` (rânduri de stoc pe care acest apel a eliberat ceva) și
   * `scanned` (rânduri de stoc CITITE ca având rezervări scadente). Doar `scanned` spune dacă lotul a fost plin: o altă
   * instanță poate goli rândurile lotului între citire și baleiere, iar atunci `items` scade deși mai sunt rezervări scadente.
   */
  async expireDue(options: { variantIds?: readonly string[]; limit?: number } = {}): Promise<{
    expired: number;
    items: number;
    scanned: number;
  }> {
    if (options.variantIds && options.variantIds.length === 0)
      return { expired: 0, items: 0, scanned: 0 };
    const now = this.now();
    const filter = options.variantIds
      ? Prisma.sql`AND "variantId" IN (${Prisma.join([...options.variantIds])})`
      : Prisma.empty;
    const due = await this.deps.db.$queryRaw<ItemKey[]>(Prisma.sql`
      SELECT "variantId", "warehouseId" FROM stock_reservation
      WHERE status = 'active' AND "expiresAt" <= ${now} ${filter}
      GROUP BY "variantId", "warehouseId"
      ORDER BY "variantId" COLLATE "C", "warehouseId" COLLATE "C"
      LIMIT ${options.limit ?? DEFAULT_EXPIRE_BATCH}`);
    let expired = 0;
    let items = 0;
    for (const key of due) {
      const count = await this.atomic(async (tx) => {
        const locked = await lockItems(tx, [key]);
        return sweepExpired(tx, [...locked.values()], now);
      });
      expired += count;
      if (count > 0) items++;
    }
    return { expired, items, scanned: due.length };
  }

  /**
   * Starea unui rând de stoc pentru calculul disponibilității, cu rezervările EXPIRATE scăzute din «rezervat» chiar dacă
   * jobul nu a rulat încă (expirarea și la citire). `null` = fără rând de stoc.
   */
  async readInventory(variantId: string, warehouseId?: string): Promise<ManagedInventory | null> {
    const warehouse = warehouseId ?? (await this.resolveDefaultWarehouse());
    const row = await this.readRow(this.deps.db, { variantId, warehouseId: warehouse });
    if (!row) return null;
    const expired = await this.deps.db.stockReservation.aggregate({
      _sum: { quantity: true },
      where: {
        variantId,
        warehouseId: warehouse,
        status: "active",
        expiresAt: { lte: this.now() },
      },
    });
    const reserved = row.reserved - (expired._sum.quantity ?? 0n);
    return {
      physical: quantityFromTicks(row.physical),
      committed: quantityFromTicks(row.committed),
      reserved: reserved < 0n ? ZERO : quantityFromTicks(reserved),
      safetyBuffer: quantityFromTicks(row.safetyBuffer),
      lowStockSteps: row.lowStockSteps,
    };
  }

  private async resolveDefaultWarehouse(): Promise<string> {
    const warehouse = await this.deps.db.warehouse.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });
    if (!warehouse) throw new StockError("STOCK_NO_WAREHOUSE", "Nu există un depozit implicit");
    return warehouse.id;
  }

  /** Contoarele `reserved` / `committed` sunt egale cu suma rândurilor active / deschise care le justifică? */
  async checkConsistency(variantId: string, warehouseId?: string): Promise<ConsistencyReport> {
    const warehouse = warehouseId ?? (await this.resolveDefaultWarehouse());
    const row = await this.readRow(this.deps.db, { variantId, warehouseId: warehouse });
    const [reservations, commitments] = await Promise.all([
      this.deps.db.stockReservation.aggregate({
        _sum: { quantity: true },
        where: { variantId, warehouseId: warehouse, status: "active" },
      }),
      this.deps.db.stockCommitment.aggregate({
        _sum: { quantity: true },
        where: { variantId, warehouseId: warehouse, status: "open" },
      }),
    ]);
    const reserved = row?.reserved ?? 0n;
    const committed = row?.committed ?? 0n;
    const reservedFromRows = reservations._sum.quantity ?? 0n;
    const committedFromRows = commitments._sum.quantity ?? 0n;
    return {
      ok: reserved === reservedFromRows && committed === committedFromRows,
      reserved: quantityFromTicks(reserved),
      reservedFromRows: quantityFromTicks(reservedFromRows),
      committed: quantityFromTicks(committed),
      committedFromRows: quantityFromTicks(committedFromRows),
    };
  }
}
