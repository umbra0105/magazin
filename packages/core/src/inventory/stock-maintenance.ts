import { Prisma, type PrismaClient } from "@ecom/db";
import type { AuditService } from "../audit/audit-service";
import { snapshotFreshness, type SnapshotFreshness } from "./reconcile";
import { StockService } from "./stock-service";

/**
 * Mentenanța stocului (Faza 5, punctul 7), apelată de joburile programate din `packages/jobs` și de scripturile de operare.
 * Fiecare operație e IDEMPOTENTĂ și sigură la instanțe simultane:
 *
 * - `expireReservations`: eliberează rezervările cu termenul trecut, în loturi (un rând de stoc pe tranzacție, prin
 *   `StockService.expireDue`, care blochează rândul și face tranziția o singură dată). Un lot făcut rămâne făcut dacă urmează
 *   o eroare; reluarea continuă de unde a rămas.
 * - `checkSnapshotFreshness`: alertă (rând în audit) când poza SmartBill a unui depozit cu stoc e mai veche decât pragul sau
 *   lipsește. Starea se citește din audit (ultimul rând «stale»/«recovered»), deci alerta se scrie la TRECERE, nu la fiecare
 *   rulare, cu memento la 24 h cât timp rămâne veche. O instanță care găsește lock-ul advisory luat de alta sare peste rulare.
 * - `purgeBackInStockAlerts`: șterge cererile «Anunță-mă» netrimise mai vechi decât retenția și, ca plasă de siguranță GDPR,
 *   pe cele trimise de mai mult de o zi, în loturi, fără să aștepte rândurile blocate de altă instanță.
 *
 * Joburile sunt de sistem (fără utilizator): nu există permisiuni de reverificat; singurele valori de la admin sunt setările,
 * pe care apelantul le citește la fiecare rulare.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_BATCHES = 50;
const MAX_PURGE_BATCHES = 200;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TRANSACTION = { maxWait: 15_000, timeout: 30_000 } as const;
const SYSTEM_LABEL = "sistem";
const FRESHNESS_LOCK_KEY = "stock-snapshot-freshness";

/** Cât timp rămâne tăcută o alertă «poza e veche» înainte de un memento (cât timp problema persistă). */
export const SNAPSHOT_REMINDER_HOURS = 24;
/** După cât timp se șterge o cerere «Anunță-mă» deja trimisă, dacă expeditorul nu a șters-o (plasă de siguranță). */
export const BACK_IN_STOCK_SENT_GRACE_DAYS = 1;

export const SNAPSHOT_STALE_ACTION = "stock.snapshot.stale";
export const SNAPSHOT_RECOVERED_ACTION = "stock.snapshot.recovered";

export interface StockMaintenanceDeps {
  db: Db;
  audit: AuditService;
  now?: () => Date;
  /** Mărimea unui lot (rânduri de stoc la expirare, rânduri șterse la curățare) */
  batchSize?: number;
  /** Doar pentru teste: serviciul de stoc care expiră rezervările */
  stock?: Pick<StockService, "expireDue">;
}

export interface ExpireReservationsResult {
  expired: number;
  batches: number;
  /** `false` = s-a oprit la plafonul de loturi; rămâne de făcut la rularea următoare */
  complete: boolean;
}

export interface WarehouseFreshness {
  warehouseId: string;
  name: string;
  status: SnapshotFreshness["status"];
  takenAt: Date | null;
  ageHours: number | null;
}

export interface WarehouseCheck extends WarehouseFreshness {
  /** S-a scris o alertă nouă (a trecut de la proaspătă/lipsă la veche) */
  alerted: boolean;
  /** S-a scris un memento (e veche de mai mult de 24 h de la ultima alertă) */
  reminded: boolean;
  /** S-a scris refacerea (a apărut o poză proaspătă după o alertă) */
  recovered: boolean;
}

export interface CheckSnapshotFreshnessResult {
  checked: number;
  alerts: number;
  recoveries: number;
  reminders: number;
  /** Altă instanță verifică chiar acum; această rulare nu a făcut nimic */
  skipped: boolean;
  warehouses: WarehouseCheck[];
}

export interface PurgeBackInStockResult {
  /** Cereri netrimise mai vechi decât retenția */
  unsent: number;
  /** Cereri deja trimise, rămase peste termenul de siguranță */
  sent: number;
}

function isRootClient(db: Db): db is PrismaClient {
  return "$transaction" in db;
}

export class StockMaintenance {
  private readonly db: Db;
  private readonly audit: AuditService;
  private readonly batchSize: number;
  private readonly stock: Pick<StockService, "expireDue">;
  private readonly nowFn: () => Date;

  constructor(deps: StockMaintenanceDeps) {
    const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError("Mărimea lotului trebuie să fie un întreg de cel puțin 1");
    }
    this.db = deps.db;
    this.audit = deps.audit;
    this.batchSize = batchSize;
    this.nowFn = deps.now ?? (() => new Date());
    this.stock = deps.stock ?? new StockService({ db: deps.db, now: this.nowFn });
  }

  private now(): Date {
    return this.nowFn();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expirarea rezervărilor
  // -------------------------------------------------------------------------------------------------------------------

  /** Eliberează rezervările cu termenul trecut, în loturi, până la golire sau până la `maxBatches`. */
  async expireReservations(
    options: { maxBatches?: number } = {},
  ): Promise<ExpireReservationsResult> {
    const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
    if (!Number.isInteger(maxBatches) || maxBatches < 1) {
      throw new RangeError("Plafonul de loturi trebuie să fie un întreg de cel puțin 1");
    }
    let expired = 0;
    let batches = 0;
    for (;;) {
      const batch = await this.stock.expireDue({ limit: this.batchSize });
      batches++;
      expired += batch.expired;
      // un lot care n-a umplut loturile înseamnă că nu mai e nimic de expirat acum
      if (batch.items < this.batchSize) return { expired, batches, complete: true };
      if (batches >= maxBatches) return { expired, batches, complete: false };
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Prospețimea pozei SmartBill
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Starea fiecărui depozit ACTIV care are rânduri de stoc: ultima poză, vârsta, «fresh» / «stale» / «never». Doar citire
   * (pentru banner-ul «stoc verificat la …» din admin); nu scrie nimic.
   */
  async getSnapshotFreshness(options: { staleHours: number }): Promise<WarehouseFreshness[]> {
    return this.freshnessOf(this.db, options.staleHours);
  }

  private async freshnessOf(db: Db, staleHours: number): Promise<WarehouseFreshness[]> {
    const now = this.now();
    snapshotFreshness(null, now, staleHours); // validează pragul (RangeError), chiar dacă nu există depozite
    const rows = await db.$queryRaw<
      Array<{ warehouseId: string; name: string; takenAt: Date | null }>
    >(Prisma.sql`
      SELECT w.id AS "warehouseId", w.name, max(s."takenAt") AS "takenAt"
      FROM warehouse w
      LEFT JOIN stock_snapshot s ON s."warehouseId" = w.id
      WHERE w."isActive"
        AND EXISTS (SELECT 1 FROM inventory_item i WHERE i."warehouseId" = w.id)
      GROUP BY w.id, w.name
      ORDER BY w.name, w.id`);
    return rows.map((row) => {
      const freshness = snapshotFreshness(row.takenAt, now, staleHours);
      return {
        warehouseId: row.warehouseId,
        name: row.name,
        status: freshness.status,
        takenAt: row.takenAt,
        ageHours: freshness.status === "never" ? null : freshness.ageHours,
      };
    });
  }

  /**
   * Verifică fiecare depozit și scrie în audit TRECEREA la «veche» (cu memento la 24 h cât timp persistă) și refacerea.
   * Două instanțe deodată nu dublează nimic: cea care nu prinde lock-ul advisory sare peste rulare, iar starea citită din
   * audit oprește orice repetare ulterioară.
   */
  async checkSnapshotFreshness(options: {
    staleHours: number;
  }): Promise<CheckSnapshotFreshnessResult> {
    snapshotFreshness(null, this.now(), options.staleHours);
    const work = async (db: Db): Promise<CheckSnapshotFreshnessResult> => {
      const [lock] = await db.$queryRaw<Array<{ locked: boolean }>>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${FRESHNESS_LOCK_KEY}, 0)) AS locked`,
      );
      if (!lock?.locked) {
        return {
          checked: 0,
          alerts: 0,
          recoveries: 0,
          reminders: 0,
          skipped: true,
          warehouses: [],
        };
      }
      const now = this.now();
      const views = await this.freshnessOf(db, options.staleHours);
      const result: CheckSnapshotFreshnessResult = {
        checked: views.length,
        alerts: 0,
        recoveries: 0,
        reminders: 0,
        skipped: false,
        warehouses: [],
      };
      for (const view of views) {
        const check: WarehouseCheck = {
          ...view,
          alerted: false,
          reminded: false,
          recovered: false,
        };
        const last = await this.lastAlertState(view.warehouseId);
        const bad = view.status !== "fresh";
        if (bad && (!last || last.action === SNAPSHOT_RECOVERED_ACTION)) {
          await this.recordFreshness(SNAPSHOT_STALE_ACTION, view, options.staleHours, now, false);
          check.alerted = true;
          result.alerts++;
        } else if (
          bad &&
          last &&
          now.getTime() - last.createdAt.getTime() >= SNAPSHOT_REMINDER_HOURS * HOUR_MS
        ) {
          await this.recordFreshness(SNAPSHOT_STALE_ACTION, view, options.staleHours, now, true);
          check.reminded = true;
          result.reminders++;
        } else if (!bad && last?.action === SNAPSHOT_STALE_ACTION) {
          await this.recordFreshness(
            SNAPSHOT_RECOVERED_ACTION,
            view,
            options.staleHours,
            now,
            false,
          );
          check.recovered = true;
          result.recoveries++;
        }
        result.warehouses.push(check);
      }
      return result;
    };
    // lock-ul advisory «de tranzacție» ține cât ține tranzacția: pe clientul rădăcină deschidem una; pe o tranzacție
    // deschisă de apelant (teste) lock-ul e al ei
    return isRootClient(this.db) ? this.db.$transaction(work, TRANSACTION) : work(this.db);
  }

  private async lastAlertState(
    warehouseId: string,
  ): Promise<{ action: string; createdAt: Date } | null> {
    const rows = await this.audit.list({ entity: "warehouse", entityId: warehouseId, limit: 20 });
    const last = rows.find(
      (row) => row.action === SNAPSHOT_STALE_ACTION || row.action === SNAPSHOT_RECOVERED_ACTION,
    );
    return last ? { action: last.action, createdAt: last.createdAt } : null;
  }

  private async recordFreshness(
    action: string,
    view: WarehouseFreshness,
    staleHours: number,
    now: Date,
    reminder: boolean,
  ): Promise<void> {
    await this.audit.record({
      actorId: null,
      actorLabel: SYSTEM_LABEL,
      action,
      entity: "warehouse",
      entityId: view.warehouseId,
      after: {
        status: view.status,
        takenAt: view.takenAt ? view.takenAt.toISOString() : null,
        staleHours,
        reminder,
        checkedAt: now.toISOString(),
      },
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Curățarea cererilor «Anunță-mă când revine»
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Șterge cererile netrimise mai vechi de `retentionDays` (strict) și cele trimise de mai mult de o zi. Rezultatul are doar
   * numere: nicio adresă de email nu ajunge în loguri.
   */
  async purgeBackInStockAlerts(options: {
    retentionDays: number;
  }): Promise<PurgeBackInStockResult> {
    const { retentionDays } = options;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      throw new RangeError("Retenția trebuie să fie un număr întreg de zile între 1 și 365");
    }
    const now = this.now().getTime();
    const unsentCutoff = new Date(now - retentionDays * DAY_MS);
    const sentCutoff = new Date(now - BACK_IN_STOCK_SENT_GRACE_DAYS * DAY_MS);
    const unsent = await this.deleteInBatches(
      Prisma.sql`"notifiedAt" IS NULL AND "createdAt" < ${unsentCutoff}`,
    );
    const sent = await this.deleteInBatches(
      Prisma.sql`"notifiedAt" IS NOT NULL AND "notifiedAt" < ${sentCutoff}`,
    );
    return { unsent, sent };
  }

  /** Șterge în loturi, fiecare lot o comandă proprie; rândurile blocate de altă instanță se sar (le șterge ea). */
  private async deleteInBatches(condition: Prisma.Sql): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
      const deleted = await this.db.$executeRaw(Prisma.sql`
        DELETE FROM back_in_stock_alert
        WHERE id IN (
          SELECT id FROM back_in_stock_alert
          WHERE ${condition}
          ORDER BY "createdAt", id
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED)`);
      total += deleted;
      if (deleted < this.batchSize) break;
    }
    return total;
  }
}
