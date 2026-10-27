import { Prisma, type PrismaClient } from "@ecom/db";
import { DomainError, ValidationError } from "@ecom/shared";
import { z } from "zod";
import { StockError } from "./stock-errors";
import { buildStockOverviewRow, type StockOverviewRow } from "./stock-overview";
import { createPrismaStockOverviewStore, type StockOverviewStore } from "./stock-overview-store";

/**
 * «Anunță-mă când revine în stoc», partea de server (Faza 5, punctul 11a, decizia D12). Un client lasă adresa de email pe o
 * variantă indisponibilă; când varianta revine, primește UN singur email, iar adresa se șterge din sistem. Formularul și ruta
 * publică sunt în Faza 7, textul de informare GDPR în Faza 18, trimiterea emailului în 11b.
 *
 * - `subscribe`: cerere nouă. Răspuns identic pentru adresă nouă și existentă (nu se poate afla ce adrese sunt înscrise).
 *   Plafoane împotriva abuzului pe adresă și pe variantă, ținute sub cereri simultane prin blocări advisory (ordine fixă:
 *   adresa, apoi varianta). O variantă care se poate comanda deja nu păstrează nimic.
 * - `findNotifiable`: cererile ale căror variante au revenit în stoc (disponibil ≥ 1 pas și ≥ minimul comandat, adică
 *   «În stoc» sau «Stoc limitat»; «La comandă» nu declanșează nimic, fiindcă se poate comanda oricum). Întoarce DOAR
 *   identificatori: adresa nu pleacă din bază până la `claim`, deci nu ajunge niciodată în Redis.
 * - `claim` / `release` / `complete`: ciclul de trimitere, cu «cel mult o dată» ca prioritate. `claim` marchează atomic
 *   (`notifiedAt`) și dă adresa; la eșecul trimiterii `release` readuce cererea în așteptare pentru reîncercare; după
 *   trimitere `complete` șterge rândul. Dacă procesul moare între `claim` și `complete`, cererea rămâne «trimisă» și o
 *   șterge curățarea de siguranță (`purgeBackInStockAlerts`): adresa nu se păstrează, iar emailul nu se dublează.
 *
 * Adresa nu intră niciodată în `audit_log` (nu se poate șterge), în loguri sau în mesajele erorilor.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Coduri stabile: `BACK_IN_STOCK_VARIANT_NOT_FOUND` (varianta nu există sau produsul ei nu e activ),
 * `BACK_IN_STOCK_EMAIL_LIMIT` (prea multe cereri în așteptare pe adresă), `BACK_IN_STOCK_VARIANT_LIMIT` (prea multe pe variantă).
 */
export class BackInStockError extends DomainError {}

/** Lungimea maximă a unei adrese (RFC 5321); aceeași limită ca CHECK-ul din bază. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL = z.string().trim().max(MAX_EMAIL_LENGTH).pipe(z.email());

/** Adresa tăiată și cu litere mici (indexul unic și plafoanele compară `lower(email)`); `ValidationError` altfel, fără adresă în mesaj. */
export function normalizeAlertEmail(input: unknown): string {
  const parsed = EMAIL.safeParse(input);
  if (!parsed.success) throw new ValidationError("Adresa de email nu este validă");
  return parsed.data.toLowerCase();
}

export interface BackInStockSettings {
  /** `inventory.lowStockSteps`, pentru starea «Stoc limitat» */
  lowStockSteps: number;
  /** `inventory.defaultLeadTimeDays` */
  defaultLeadTimeDays: number;
  /** `inventory.backInStockMaxPerEmail` */
  maxPerEmail: number;
  /** `inventory.backInStockMaxPerVariant` */
  maxPerVariant: number;
}

export interface BackInStockServiceDeps {
  db: Db;
  /** Setările se citesc la fiecare apel, nu o dată la pornire */
  readSettings: () => Promise<BackInStockSettings>;
  /** Depozitul din care se citește stocul; implicit depozitul implicit (singurul vizibil) */
  warehouseId?: string;
  store?: StockOverviewStore;
  now?: () => Date;
}

export type SubscribeResult = { status: "registered" } | { status: "available" };

export interface NotifiableAlert {
  id: string;
  variantId: string;
}

export type ClaimResult =
  | {
      status: "claimed";
      alert: {
        id: string;
        email: string;
        productTitle: string;
        productSlug: string;
        variantLabel: string | null;
      };
    }
  /** Cererea nu mai există sau a fost deja luată: nimic de făcut */
  | { status: "gone" }
  /** Varianta nu mai e disponibilă (sau produsul nu mai e activ): cererea rămâne în așteptare */
  | { status: "unavailable" };

type Tx = Prisma.TransactionClient;

const TRANSACTION = { maxWait: 15_000, timeout: 30_000 } as const;
/** Câte variante cu cereri se citesc dintr-o dată la selecție */
const CANDIDATE_CHUNK = 200;

function isRootClient(db: Db): db is PrismaClient {
  return "$transaction" in db;
}

/** Blocare advisory pe durata tranzacției, pe o cheie text (nu apare nicăieri în afara conexiunii). */
async function lock(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

const emailLockKey = (email: string): string => `back-in-stock:email:${email}`;
const variantLockKey = (variantId: string): string => `back-in-stock:variant:${variantId}`;

/** A revenit în stoc: se poate comanda în pași întregi și în limitele stocului (nu «La comandă», nu «Indisponibil»). */
function isBackInStock(row: Pick<StockOverviewRow, "state">): boolean {
  return row.state === "in_stock" || row.state === "limited";
}

export class BackInStockService {
  private readonly db: Db;
  private readonly store: StockOverviewStore;
  private readonly readSettings: () => Promise<BackInStockSettings>;
  private readonly fixedWarehouseId: string | undefined;
  private readonly nowFn: () => Date;

  constructor(deps: BackInStockServiceDeps) {
    this.db = deps.db;
    this.store = deps.store ?? createPrismaStockOverviewStore(deps.db);
    this.readSettings = deps.readSettings;
    this.fixedWarehouseId = deps.warehouseId;
    this.nowFn = deps.now ?? (() => new Date());
  }

  private async atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // într-o tranzacție deja deschisă (teste cu tranzacție anulată) se lucrează direct în ea
    return isRootClient(this.db) ? this.db.$transaction(fn, TRANSACTION) : fn(this.db);
  }

  private async warehouseId(): Promise<string> {
    if (this.fixedWarehouseId) return this.fixedWarehouseId;
    const warehouse = await this.store.defaultWarehouse();
    if (!warehouse) throw new StockError("STOCK_NO_WAREHOUSE", "Nu există un depozit implicit");
    return warehouse.id;
  }

  /** Rândul de stoc al unei variante dintr-un produs ACTIV și neșters; `null` altfel. */
  private async liveRow(
    variantId: string,
    settings: BackInStockSettings,
    warehouseId: string,
  ): Promise<StockOverviewRow | null> {
    const live = await this.db.productVariant.findFirst({
      where: { id: variantId, product: { status: "active", deletedAt: null } },
      select: { id: true },
    });
    return live ? this.rowOf(variantId, settings, warehouseId) : null;
  }

  private async rowOf(
    variantId: string,
    settings: BackInStockSettings,
    warehouseId: string,
  ): Promise<StockOverviewRow | null> {
    const source = await this.store.getSource(variantId, warehouseId);
    return source
      ? buildStockOverviewRow(source, {
          defaultLowStockSteps: settings.lowStockSteps,
          defaultLeadTimeDays: settings.defaultLeadTimeDays,
        })
      : null;
  }

  async subscribe(input: { variantId: string; email: unknown }): Promise<SubscribeResult> {
    const email = normalizeAlertEmail(input.email);
    const settings = await this.readSettings();
    const row = await this.liveRow(input.variantId, settings, await this.warehouseId());
    if (!row) {
      throw new BackInStockError(
        "BACK_IN_STOCK_VARIANT_NOT_FOUND",
        "Varianta nu există sau produsul ei nu este în vânzare",
      );
    }
    // se poate comanda deja (inclusiv «La comandă»): nu păstrăm adresa degeaba
    if (row.state !== "unavailable") return { status: "available" };

    await this.atomic(async (tx) => {
      // ordine fixă a blocărilor (adresa, apoi varianta): fără blocări în cerc
      await lock(tx, emailLockKey(email));
      const existing = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
        SELECT 1 AS one FROM back_in_stock_alert
        WHERE "variantId" = ${input.variantId} AND lower("email") = ${email} AND "notifiedAt" IS NULL
        LIMIT 1`);
      if (existing.length > 0) return; // idempotent: același răspuns, nimic consumat din plafon

      const [perEmail] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*) AS count FROM back_in_stock_alert
        WHERE lower("email") = ${email} AND "notifiedAt" IS NULL`);
      if ((perEmail?.count ?? 0n) >= BigInt(settings.maxPerEmail)) {
        throw new BackInStockError(
          "BACK_IN_STOCK_EMAIL_LIMIT",
          "Ai atins numărul maxim de cereri în așteptare pentru această adresă",
        );
      }
      await lock(tx, variantLockKey(input.variantId));
      const [perVariant] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*) AS count FROM back_in_stock_alert
        WHERE "variantId" = ${input.variantId} AND "notifiedAt" IS NULL`);
      if ((perVariant?.count ?? 0n) >= BigInt(settings.maxPerVariant)) {
        throw new BackInStockError(
          "BACK_IN_STOCK_VARIANT_LIMIT",
          "Pentru acest produs sunt deja prea multe cereri în așteptare",
        );
      }
      await tx.backInStockAlert.create({ data: { variantId: input.variantId, email } });
    });
    return { status: "registered" };
  }

  /** Cererile în așteptare ale variantelor care au revenit în stoc, cele mai vechi primele, cel mult `limit`. */
  async findNotifiable(options: { limit: number }): Promise<NotifiableAlert[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError("Limita trebuie să fie un întreg de cel puțin 1");
    }
    const settings = await this.readSettings();
    const warehouseId = await this.warehouseId();
    const ready: string[] = [];
    let after: string | null = null;
    // Variantele cu cereri, în pagini, până se strâng destule cereri sau se termină: o variantă mereu indisponibilă nu
    // blochează pe cele de după ea. Costul (o citire pe variantă cu cereri) e cunoscut; optimizarea intră în Faza 20.
    for (;;) {
      const chunk: Array<{ variantId: string }> = await this.db.$queryRaw(Prisma.sql`
        SELECT "variantId" FROM back_in_stock_alert
        WHERE "notifiedAt" IS NULL ${after === null ? Prisma.empty : Prisma.sql`AND "variantId" > ${after}`}
        GROUP BY "variantId" ORDER BY "variantId" LIMIT ${CANDIDATE_CHUNK}`);
      if (chunk.length === 0) break;
      after = chunk[chunk.length - 1]!.variantId;
      const live = await this.db.productVariant.findMany({
        where: {
          id: { in: chunk.map((c) => c.variantId) },
          product: { status: "active", deletedAt: null },
        },
        select: { id: true },
      });
      for (const { id } of live) {
        const row = await this.rowOf(id, settings, warehouseId);
        if (row && isBackInStock(row)) ready.push(id);
      }
      if (chunk.length < CANDIDATE_CHUNK) break;
    }
    if (ready.length === 0) return [];
    return this.db.backInStockAlert.findMany({
      where: { variantId: { in: ready }, notifiedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.limit,
      select: { id: true, variantId: true },
    });
  }

  /** Marchează atomic cererea ca trimisă și dă datele emailului; un singur apel câștigă la apeluri simultane. */
  async claim(alertId: string): Promise<ClaimResult> {
    const alert = await this.db.backInStockAlert.findUnique({
      where: { id: alertId },
      select: { id: true, email: true, variantId: true, notifiedAt: true },
    });
    if (!alert || alert.notifiedAt !== null) return { status: "gone" };
    const settings = await this.readSettings();
    const row = await this.liveRow(alert.variantId, settings, await this.warehouseId());
    if (!row || !isBackInStock(row)) return { status: "unavailable" };
    const claimed = await this.db.backInStockAlert.updateMany({
      where: { id: alertId, notifiedAt: null },
      data: { notifiedAt: this.nowFn() },
    });
    if (claimed.count === 0) return { status: "gone" };
    return {
      status: "claimed",
      alert: {
        id: alert.id,
        email: alert.email,
        productTitle: row.productTitle,
        productSlug: row.productSlug,
        variantLabel: row.variantLabel,
      },
    };
  }

  /**
   * Trimiterea a eșuat: cererea revine în așteptare, ca reîncercarea să o poată lua din nou. Dacă între timp aceeași adresă a
   * cerut din nou aceeași variantă, cererea luată se șterge (cea nouă o acoperă), ca să nu încalce unicitatea.
   * `true` = există o cerere în așteptare pentru ea; `false` = nu era luată.
   */
  async release(alertId: string): Promise<boolean> {
    return this.atomic(async (tx) => {
      const alert = await tx.backInStockAlert.findUnique({
        where: { id: alertId },
        select: { variantId: true, email: true, notifiedAt: true },
      });
      if (!alert || alert.notifiedAt === null) return false;
      const email = alert.email.toLowerCase();
      // aceeași blocare ca la `subscribe`: o cerere nouă nu se strecoară între verificare și actualizare
      await lock(tx, emailLockKey(email));
      const duplicate = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
        SELECT 1 AS one FROM back_in_stock_alert
        WHERE "variantId" = ${alert.variantId} AND lower("email") = ${email}
          AND "notifiedAt" IS NULL AND "id" <> ${alertId}
        LIMIT 1`);
      if (duplicate.length > 0) {
        await tx.backInStockAlert.deleteMany({ where: { id: alertId, notifiedAt: { not: null } } });
        return true;
      }
      const released = await tx.backInStockAlert.updateMany({
        where: { id: alertId, notifiedAt: { not: null } },
        data: { notifiedAt: null },
      });
      return released.count > 0;
    });
  }

  /** Emailul a plecat: șterge cererea luată (adresa dispare din bază). `false` dacă nu era luată sau nu mai există. */
  async complete(alertId: string): Promise<boolean> {
    const deleted = await this.db.backInStockAlert.deleteMany({
      where: { id: alertId, notifiedAt: { not: null } },
    });
    return deleted.count > 0;
  }
}
