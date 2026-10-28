import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import { readStockReportFile, type StockReportFile } from "@ecom/integrations";
import { formatQuantity, formatSignedDelta } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { StockError } from "./stock-errors";
import {
  computePlanHash,
  describeSnapshotReport,
  selectImportTargets,
  type ZeroMissingRequest,
} from "./stock-report-import-rules";
import {
  planStockReport,
  type StockReportIssue,
  type StockReportPlan,
  type StockReportWarning,
} from "./stock-report-plan";
import { checkSnapshotTime, type SnapshotTimeWarning } from "./stock-report-time";
import { loadReportVariants } from "./stock-report-variants";
import { StockService, runStockTransaction, type ApplySnapshotInput } from "./stock-service";
import { normalizeUnitText } from "./smartbill-units";

/**
 * Importul «stoc la zi» din raportul SmartBill (Faza 5, punctul 12c): serviciul peste cititorul de fișier
 * (`@ecom/integrations`), planul pur (`stock-report-plan.ts`) și `StockService.applySnapshot`.
 *
 * - `preview`: citește fișierul, rulează planul și verificarea orei și întoarce raportul. NU modifică nimic și nu păstrează
 *   fișierul (nici pe disc, nici în Redis): la aplicare browserul retrimite același fișier.
 * - `apply`: recalculează tot, refuză dacă amprenta planului diferă de cea previzualizată și aplică TOATE liniile într-o
 *   singură tranzacție (un rând `StockSnapshot` + `applySnapshot` pe fiecare variantă, în ordinea fixă de blocare); orice
 *   eroare sau o poză care nu e mai nouă decât una deja aplicată anulează tot. Variantele lipsă din fișier se pun pe 0 doar
 *   cu confirmare explicită. Importul nu pornește niciodată gestionarea stocului (variantele negestionate se raportează).
 * - Citirea istoricului cere `inventory.read`; previzualizarea, aplicarea și alegerea gestiunilor cer `inventory.write`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Cât din fiecare listă ajunge în răspuns (totalul rămâne în contoare); aplicarea nu depinde de aceste plafoane. */
export const STOCK_IMPORT_LIST_LIMIT = 300;
const TRANSACTION_TIMEOUT_MS = 300_000;
const HISTORY_PAGE_SIZE = 20;

export interface StockImportSettings {
  /** `inventory.smartbillWarehouses` */
  warehouses: string[];
  /** `regional.timezone` */
  timeZone: string;
  /** `inventory.snapshotSafetyWindowMinutes` */
  safetyWindowMinutes: number;
}

export interface StockImportSettingsPort {
  read(): Promise<StockImportSettings>;
  /** Scrie `inventory.smartbillWarehouses` și întoarce valoarea validată */
  writeWarehouses(names: string[]): Promise<string[]>;
}

export interface StockSnapshotApplier {
  applySnapshot: StockService["applySnapshot"];
}

export interface StockReportImportDeps {
  db: Db;
  /** Depozitul vizat; implicit depozitul implicit (D3: o singură locație vizibilă) */
  warehouseId?: string;
  audit: AuditService;
  settings: StockImportSettingsPort;
  now?: () => Date;
  /** Înlocuibil în teste */
  readFile?: (bytes: Uint8Array) => Promise<StockReportFile>;
  /** Serviciul de stoc legat de tranzacția importului (implicit `StockService`) */
  createStock?: (tx: Db, now: () => Date) => StockSnapshotApplier;
}

export interface PreviewInput {
  bytes: Uint8Array;
  fileName: string | null;
  /** Ora pozei confirmată de utilizator; implicit acum */
  takenAt?: Date;
}

export interface ApplyInput {
  bytes: Uint8Array;
  fileName: string | null;
  takenAt: Date;
  planHash: string;
  /** Bifa «am verificat ora», obligatorie când ora are avertismente */
  acknowledgeTimeWarnings: boolean;
  zeroMissing?: ZeroMissingRequest;
}

/** Parametrii aplicării, așa cum vin din cerere (ruta de încărcare); fișierul vine separat, în corp. */
export const applyOptionsSchema = z.strictObject({
  takenAt: z.coerce.date({ error: "Data și ora raportului nu sunt valide" }),
  planHash: z.string().regex(/^[0-9a-f]{64}$/, "Amprenta verificării lipsește"),
  acknowledgeTimeWarnings: z.boolean().default(false),
  zeroMissing: z
    .strictObject({
      confirm: z.literal(true),
      expectedCount: z.number().int().min(0).max(1_000_000),
    })
    .optional(),
});

export const previewOptionsSchema = z.strictObject({
  takenAt: z.coerce.date({ error: "Data și ora raportului nu sunt valide" }).optional(),
});

export interface WarehouseInFile {
  name: string;
  rows: number;
  chosen: boolean;
}

export interface PreviewLineView {
  rowNumber: number;
  sku: string;
  label: string;
  fileQuantity: string;
  quantity: string;
  current: string | null;
  difference: string;
  changed: boolean;
  warnings: string[];
}

export interface PreviewListed<T> {
  total: number;
  items: T[];
}

export interface StockReportPreview {
  /** `ready` = se poate aplica; `blocked` = erori; `warehouse` = gestiunea nu e aleasă sau nu apare în fișier */
  status: "ready" | "blocked" | "warehouse";
  fileName: string | null;
  fileHash: string;
  format: "xls" | "xlsx";
  /** Data din antetul raportului (`2026-10-28`), sau `null` */
  fileDate: string | null;
  warehousesInFile: WarehouseInFile[];
  chosenWarehouses: string[];
  warehouseProblem: { kind: "none_chosen" | "not_found"; message: string } | null;
  /** `null` când data primită nu este validă */
  takenAt: string | null;
  timeValid: boolean;
  timeWarnings: SnapshotTimeWarning[];
  /** Ora celei mai noi poze aplicate în depozit */
  lastSnapshotAt: string | null;
  blockers: string[];
  counters: StockReportPlan["counters"] | null;
  planHash: string | null;
  canApply: boolean;
  lines: PreviewListed<PreviewLineView>;
  errors: PreviewListed<StockReportIssue>;
  warnings: PreviewListed<StockReportWarning>;
  unknownCodes: PreviewListed<{ rowNumber: number; code: string }>;
  unmanaged: PreviewListed<{ rowNumber: number; sku: string; label: string }>;
  missing: PreviewListed<{ sku: string; label: string; currentPhysical: string | null }>;
}

export interface ApplyResult {
  snapshotId: string;
  /** Câte variante au primit cantitatea din fișier */
  applied: number;
  /** Câte variante lipsă din fișier au fost puse pe 0 (cu confirmare) */
  zeroed: number;
  /** Câte angajări de comenzi au fost oglindite de poză */
  mirrored: number;
  counters: StockReportPlan["counters"];
}

export interface SnapshotHistoryRow {
  id: string;
  takenAt: Date;
  createdAt: Date;
  fileName: string | null;
  /** Primele 12 caractere din amprenta fișierului */
  fileHash: string | null;
  rowCount: number;
  actorLabel: string | null;
  source: string;
  warehouseName: string;
  /** Din raportul păstrat: câte variante s-au schimbat / au rămas neschimbate / au fost puse pe 0 */
  changed: number | null;
  unchanged: number | null;
  zeroed: number | null;
}

const MAX_WAREHOUSES = 20;

interface Analysis {
  file: StockReportFile;
  settings: StockImportSettings;
  warehouse: { id: string; name: string };
  plan: StockReportPlan | null;
  warehouseProblem: StockReportPreview["warehouseProblem"];
  chosen: string[];
  warehousesInFile: WarehouseInFile[];
  takenAt: Date;
  time: ReturnType<typeof checkSnapshotTime>;
  lastSnapshotAt: Date | null;
  blockers: string[];
}

const dayText = (date: { year: number; month: number; day: number } | null): string | null =>
  date
    ? `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
    : null;

function listed<T, V>(items: readonly T[], view: (item: T) => V): PreviewListed<V> {
  return { total: items.length, items: items.slice(0, STOCK_IMPORT_LIST_LIMIT).map(view) };
}

function distinctWarehouses(file: StockReportFile, chosen: readonly string[]): WarehouseInFile[] {
  const chosenKeys = new Set(chosen.map((name) => normalizeUnitText(name)));
  const byKey = new Map<string, WarehouseInFile>();
  for (const row of file.rows) {
    const name = (row.warehouse ?? "").trim();
    const key = normalizeUnitText(name);
    if (key === "") continue;
    const entry = byKey.get(key) ?? { name, rows: 0, chosen: chosenKeys.has(key) };
    entry.rows += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

export class StockReportImportService {
  constructor(private readonly deps: StockReportImportDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async defaultWarehouse(): Promise<{ id: string; name: string }> {
    const warehouse = await this.deps.db.warehouse.findFirst({
      where: this.deps.warehouseId ? { id: this.deps.warehouseId } : { isDefault: true },
      select: { id: true, name: true },
    });
    if (!warehouse) {
      throw new StockError("STOCK_NO_WAREHOUSE", "Nu există un depozit implicit pentru stoc.");
    }
    return warehouse;
  }

  private async analyze(bytes: Uint8Array, takenAtInput: Date | undefined): Promise<Analysis> {
    const settings = await this.deps.settings.read();
    const file = await (this.deps.readFile ?? readStockReportFile)(bytes);
    const warehouse = await this.defaultWarehouse();
    const now = this.now();
    const takenAt = takenAtInput ?? now;
    const chosen = settings.warehouses.filter((name) => normalizeUnitText(name) !== "");
    const warehousesInFile = distinctWarehouses(file, chosen);

    let plan: StockReportPlan | null = null;
    let warehouseProblem: Analysis["warehouseProblem"] = null;
    try {
      const variants = await loadReportVariants(this.deps.db, warehouse.id);
      plan = planStockReport({ rows: file.rows, warehouses: chosen, variants });
    } catch (error) {
      if (error instanceof StockError && error.code === "STOCK_REPORT_NO_WAREHOUSE") {
        warehouseProblem = { kind: "none_chosen", message: error.message };
      } else if (error instanceof StockError && error.code === "STOCK_REPORT_WAREHOUSE_NOT_FOUND") {
        warehouseProblem = { kind: "not_found", message: error.message };
      } else {
        throw error;
      }
    }

    const time = checkSnapshotTime({
      takenAt,
      now,
      fileDate: file.fileDate,
      timeZone: settings.timeZone,
    });

    const last = await this.deps.db.stockSnapshot.findFirst({
      where: { warehouseId: warehouse.id },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    const lastSnapshotAt = last?.takenAt ?? null;
    const blockers: string[] = [];
    if (time.ok && lastSnapshotAt && takenAt.getTime() <= lastSnapshotAt.getTime()) {
      blockers.push(
        "Ora raportului nu este mai nouă decât a ultimei sincronizări aplicate. O poză mai veche nu poate înlocui una mai nouă.",
      );
    }
    return {
      file,
      settings,
      warehouse,
      plan,
      warehouseProblem,
      chosen,
      warehousesInFile,
      takenAt,
      time,
      lastSnapshotAt,
      blockers,
    };
  }

  private hashOf(analysis: Analysis & { plan: StockReportPlan }): string {
    return computePlanHash({
      fileHash: analysis.file.fileHash,
      warehouses: analysis.chosen,
      plan: analysis.plan,
    });
  }

  /** Verificarea fără modificări: raportul pe care îl vede utilizatorul înainte de aplicare. */
  async preview(
    subject: PermissionSubject | null,
    input: PreviewInput,
  ): Promise<StockReportPreview> {
    assertCan(subject, "inventory.write");
    const analysis = await this.analyze(input.bytes, input.takenAt);
    const { file, plan } = analysis;
    const base = {
      fileName: input.fileName,
      fileHash: file.fileHash,
      format: file.format,
      fileDate: dayText(file.fileDate),
      warehousesInFile: analysis.warehousesInFile,
      chosenWarehouses: analysis.chosen,
      warehouseProblem: analysis.warehouseProblem,
      takenAt: analysis.time.ok ? analysis.takenAt.toISOString() : null,
      timeValid: analysis.time.ok,
      timeWarnings: analysis.time.warnings,
      lastSnapshotAt: analysis.lastSnapshotAt?.toISOString() ?? null,
      blockers: analysis.blockers,
    };
    const empty = { total: 0, items: [] };
    if (!plan) {
      return {
        ...base,
        status: "warehouse",
        counters: null,
        planHash: null,
        canApply: false,
        lines: empty,
        errors: empty,
        warnings: empty,
        unknownCodes: empty,
        unmanaged: empty,
        missing: empty,
      };
    }
    const canApply = plan.canApply && analysis.time.ok && analysis.blockers.length === 0;
    // liniile care se schimbă primele, apoi cele neschimbate
    const lines = [...plan.lines].sort(
      (a, b) =>
        (a.difference !== 0n ? 0 : 1) - (b.difference !== 0n ? 0 : 1) || a.rowNumber - b.rowNumber,
    );
    return {
      ...base,
      status: canApply ? "ready" : "blocked",
      counters: plan.counters,
      planHash: this.hashOf({ ...analysis, plan }),
      canApply,
      lines: listed(lines, (line) => ({
        rowNumber: line.rowNumber,
        sku: line.sku,
        label: line.label,
        fileQuantity: formatQuantity(line.fileQuantity),
        quantity: formatQuantity(line.quantity),
        current: line.current === null ? null : formatQuantity(line.current),
        difference: formatSignedDelta(line.difference),
        changed: line.difference !== 0n,
        warnings: [...line.warnings],
      })),
      errors: listed(plan.errors, (issue) => issue),
      warnings: listed(plan.warnings, (warning) => warning),
      unknownCodes: listed(plan.unknownCodes, (entry) => entry),
      unmanaged: listed(plan.unmanaged, (entry) => ({
        rowNumber: entry.rowNumber,
        sku: entry.sku,
        label: entry.label,
      })),
      missing: listed(plan.missingManaged, (entry) => ({
        sku: entry.sku,
        label: entry.label,
        currentPhysical:
          entry.currentPhysical === null ? null : formatQuantity(entry.currentPhysical),
      })),
    };
  }

  /** Aplicarea toată-sau-deloc. Refuză tot ce nu e exact ce s-a previzualizat. */
  async apply(subject: PermissionSubject | null, input: ApplyInput): Promise<ApplyResult> {
    assertCan(subject, "inventory.write");
    const analysis = await this.analyze(input.bytes, input.takenAt);
    const { plan } = analysis;
    if (!plan) {
      throw new StockError(
        "STOCK_IMPORT_WAREHOUSE_REQUIRED",
        analysis.warehouseProblem?.message ?? "Gestiunea SmartBill nu este aleasă.",
      );
    }
    if (!analysis.time.ok) {
      throw new StockError("STOCK_IMPORT_TIME_INVALID", "Data și ora raportului nu sunt valide.");
    }
    if (analysis.blockers.length > 0) {
      throw new StockError("STOCK_IMPORT_NOT_NEWER", analysis.blockers.join(" "), {
        lastSnapshotAt: analysis.lastSnapshotAt?.toISOString() ?? null,
      });
    }
    if (this.hashOf({ ...analysis, plan }) !== input.planHash) {
      throw new StockError(
        "STOCK_IMPORT_PLAN_CHANGED",
        "Fișierul, setările sau stocul s-au schimbat de la verificare. Verifică din nou înainte de a aplica.",
      );
    }
    if (analysis.time.warnings.length > 0 && !input.acknowledgeTimeWarnings) {
      throw new StockError(
        "STOCK_IMPORT_TIME_NOT_ACKNOWLEDGED",
        "Ora raportului are avertismente: confirmă că ai verificat-o.",
        { kinds: analysis.time.warnings.map((w) => w.kind) },
      );
    }
    const targets = selectImportTargets(plan, input.zeroMissing);
    const zeroed = targets.filter((t) => t.kind === "zeroed").length;
    const report = describeSnapshotReport({
      plan,
      zeroedCount: zeroed,
      timeWarnings: analysis.time.warnings.map((w) => w.kind),
      fileDate: analysis.file.fileDate,
    });
    const actor = subject as PermissionSubject;
    const safetyWindowMinutes = analysis.settings.safetyWindowMinutes;
    const now = () => this.now();

    const outcome = await runStockTransaction(
      this.deps.db,
      async (tx) => {
        const snapshot = await tx.stockSnapshot.create({
          data: {
            warehouseId: analysis.warehouse.id,
            takenAt: analysis.takenAt,
            source: "import",
            fileName: input.fileName,
            fileHash: analysis.file.fileHash,
            rowCount: analysis.file.counters.dataRows,
            actorId: actor.userId,
            actorLabel: actor.email,
            report: report as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        const stock = (this.deps.createStock ?? defaultStock)(tx, now);
        let mirrored = 0;
        for (const target of targets) {
          const call: ApplySnapshotInput = {
            variantId: target.variantId,
            warehouseId: analysis.warehouse.id,
            snapshotId: snapshot.id,
            quantity: target.quantity,
            takenAt: analysis.takenAt,
            safetyWindowMinutes,
          };
          const result = await stock.applySnapshot(call);
          if (!result.applied) {
            // un rând de stoc are deja o poză mai nouă: nu se aplică pe jumătate
            throw new StockError(
              "STOCK_IMPORT_NOT_NEWER",
              "Cel puțin o variantă are deja o sincronizare mai nouă decât ora raportului. Nu s-a aplicat nimic.",
              { sku: target.sku },
            );
          }
          mirrored += result.mirroredIds.length;
        }
        return { snapshotId: snapshot.id, mirrored };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    const applied = targets.length - zeroed;
    await this.deps.audit.record({
      actorId: actor.userId,
      actorLabel: actor.email,
      action: "stock.import.apply",
      entity: "stock_snapshot",
      entityId: outcome.snapshotId,
      after: {
        fileName: input.fileName,
        fileHash: analysis.file.fileHash,
        takenAt: analysis.takenAt.toISOString(),
        warehouse: analysis.warehouse.name,
        warehousesRead: plan.warehousesRead,
        applied,
        zeroedMissing: zeroed,
        mirrored: outcome.mirrored,
        counters: plan.counters,
        timeWarnings: analysis.time.warnings.map((w) => w.kind),
      },
    });
    return {
      snapshotId: outcome.snapshotId,
      applied,
      zeroed,
      mirrored: outcome.mirrored,
      counters: plan.counters,
    };
  }

  /** Istoricul pozelor, cele mai noi primele. Cere `inventory.read`. */
  async history(
    subject: PermissionSubject | null,
    options: { page?: number } = {},
  ): Promise<{ rows: SnapshotHistoryRow[]; total: number; pageSize: number }> {
    assertCan(subject, "inventory.read");
    const page =
      Number.isSafeInteger(options.page) && (options.page ?? 0) >= 1 ? (options.page as number) : 1;
    const [total, rows] = await Promise.all([
      this.deps.db.stockSnapshot.count(),
      this.deps.db.stockSnapshot.findMany({
        orderBy: [{ takenAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * HISTORY_PAGE_SIZE,
        take: HISTORY_PAGE_SIZE,
        select: {
          id: true,
          takenAt: true,
          createdAt: true,
          fileName: true,
          fileHash: true,
          rowCount: true,
          actorLabel: true,
          source: true,
          report: true,
          warehouse: { select: { name: true } },
        },
      }),
    ]);
    return {
      total,
      pageSize: HISTORY_PAGE_SIZE,
      rows: rows.map((row) => {
        const parsed = reportSummary(row.report);
        return {
          id: row.id,
          takenAt: row.takenAt,
          createdAt: row.createdAt,
          fileName: row.fileName,
          fileHash: row.fileHash ? row.fileHash.slice(0, 12) : null,
          rowCount: row.rowCount,
          actorLabel: row.actorLabel,
          source: row.source,
          warehouseName: row.warehouse.name,
          ...parsed,
        };
      }),
    };
  }

  /** Gestiunile SmartBill citite la import. Cere `inventory.write`; scrie auditul cu valoarea dinainte și de după. */
  async setWarehouses(subject: PermissionSubject | null, input: unknown): Promise<string[]> {
    assertCan(subject, "inventory.write");
    const parsed = z
      .array(z.string().trim().min(1, "Numele gestiunii nu poate fi gol").max(100))
      .max(MAX_WAREHOUSES, `Cel mult ${MAX_WAREHOUSES} de gestiuni`)
      .safeParse(input);
    if (!parsed.success) {
      throw new StockError(
        "STOCK_IMPORT_WAREHOUSES_INVALID",
        parsed.error.issues[0]?.message ?? "Gestiunile alese nu sunt valide.",
      );
    }
    const seen = new Set<string>();
    const names = parsed.data.filter((name) => {
      const key = normalizeUnitText(name);
      if (key === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const before = (await this.deps.settings.read()).warehouses;
    const after = await this.deps.settings.writeWarehouses(names);
    const same =
      before.length === after.length && before.every((name, index) => name === after[index]);
    if (!same) {
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "stock.import.warehouses.update",
        entity: "setting",
        entityId: "inventory.smartbillWarehouses",
        before: { warehouses: before },
        after: { warehouses: after },
      });
    }
    return after;
  }
}

function defaultStock(tx: Db, now: () => Date): StockSnapshotApplier {
  return new StockService({ db: tx, now });
}

const reportShape = z.object({
  counters: z.object({ changed: z.number(), unchanged: z.number() }),
  zeroedMissing: z.number(),
});

function reportSummary(report: unknown): {
  changed: number | null;
  unchanged: number | null;
  zeroed: number | null;
} {
  const parsed = reportShape.safeParse(report);
  if (!parsed.success) return { changed: null, unchanged: null, zeroed: null };
  return {
    changed: parsed.data.counters.changed,
    unchanged: parsed.data.counters.unchanged,
    zeroed: parsed.data.zeroedMissing,
  };
}
