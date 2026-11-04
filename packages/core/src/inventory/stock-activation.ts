import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import { readStockReportFile, type StockReportFile } from "@ecom/integrations";
import type { AuditInput, AuditService } from "../audit/audit-service";
import { CATALOG_TAG } from "../catalog/catalog-support";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { normalizeUnitText } from "./smartbill-units";
import {
  STOCK_ACTIVATION_MAX_VARIANTS,
  checkActivationConfirm,
  computeActivationHash,
  planStockActivation,
  selectActivationTargets,
  type ActivationConfirm,
  type ActivationCounters,
  type ActivationVariantRef,
  type StockActivationPlan,
  type UntouchedVariant,
} from "./stock-activation-plan";
import { StockError } from "./stock-errors";
import {
  dayText,
  distinctWarehouses,
  listed,
  type PreviewListed,
  type StockImportSettingsPort,
  type StockImportSettings,
  type StockSnapshotApplier,
  type WarehouseInFile,
} from "./stock-report-import";
import { describeSnapshotReport } from "./stock-report-import-rules";
import type { StockReportIssue, StockReportPlan, StockReportWarning } from "./stock-report-plan";
import { checkSnapshotTime, type SnapshotTimeWarning } from "./stock-report-time";
import { loadReportCatalog } from "./stock-report-variants";
import { StockService, runStockTransaction, type ApplySnapshotInput } from "./stock-service";

/**
 * Pornirea în masă a gestionării stocului din fișierul SmartBill (Faza 5, punctul 12e). Acțiune explicită, separată de
 * importul de cantități: pornește gestionarea variantelor din fișier ȘI aplică, în aceeași tranzacție, cantitățile din același
 * fișier (nicio variantă nu devine «Indisponibil» între «pornește» și cantități). Planul și regulile sunt în
 * `stock-activation-plan.ts`; aici sunt citirea, tranzacția și auditul.
 *
 * - `preview`: nu modifică nimic și nu păstrează fișierul; arată ce se pornește (și la ce nivel), ce rămâne neatins și, ca
 *   opțiune explicită, câte variante fără potrivire ar porni cu stoc 0.
 * - `apply`: recalculează tot și refuză dacă amprenta diferă de cea previzualizată, dacă numerele confirmate nu sunt cele
 *   din plan sau dacă depășește plafonul; apoi o singură tranzacție: schimbă bifele (cu gardă: o bifă schimbată între timp
 *   anulează tot), creează `StockSnapshot` și aplică `applySnapshot` în ordinea fixă de blocare.
 * - Drepturi: `products.write` ȘI `inventory.write`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const TRANSACTION_TIMEOUT_MS = 300_000;
/** Câte rânduri se actualizează într-o comandă */
const UPDATE_CHUNK = 1000;

export interface StockActivationDeps {
  db: Db;
  /** Depozitul vizat; implicit depozitul implicit (D3: o singură locație vizibilă) */
  warehouseId?: string;
  audit: AuditService;
  settings: StockImportSettingsPort;
  now?: () => Date;
  /** Plafonul variantelor pornite într-o aplicare (implicit 5.000) */
  maxVariants?: number;
  /** Înlocuibil în teste */
  readFile?: (bytes: Uint8Array) => Promise<StockReportFile>;
  /** Serviciul de stoc legat de tranzacție (implicit `StockService`) */
  createStock?: (tx: Db, now: () => Date) => StockSnapshotApplier;
  /** Invalidarea cache-ului catalogului după scriere; un eșec nu anulează scrierea */
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
}

export interface ActivationPreviewInput {
  bytes: Uint8Array;
  fileName: string | null;
  takenAt?: Date;
  /** Opțiunea «Pornește și variantele fără potrivire în fișier, cu stoc 0» */
  startUnmatched?: boolean;
}

export interface ActivationApplyInput {
  bytes: Uint8Array;
  fileName: string | null;
  takenAt: Date;
  planHash: string;
  acknowledgeTimeWarnings: boolean;
  startUnmatched: boolean;
  /** Numerele văzute în previzualizare */
  confirm: ActivationConfirm;
}

/** Parametrii aplicării, așa cum vin din cerere (ruta de încărcare); fișierul vine separat, în corp. */
export const activationApplyOptionsSchema = z.strictObject({
  takenAt: z.coerce.date({ error: "Data și ora raportului nu sunt valide" }),
  planHash: z.string().regex(/^[0-9a-f]{64}$/, "Amprenta verificării lipsește"),
  acknowledgeTimeWarnings: z.boolean().default(false),
  startUnmatched: z.boolean().default(false),
  confirm: z.strictObject({
    products: z.number().int().min(0).max(1_000_000),
    variants: z.number().int().min(0).max(1_000_000),
    zero: z.number().int().min(0).max(1_000_000),
  }),
});

export const activationPreviewOptionsSchema = z.strictObject({
  takenAt: z.coerce.date({ error: "Data și ora raportului nu sunt valide" }).optional(),
  startUnmatched: z.boolean().default(false),
});

export interface ActivationChangeView {
  scope: "product" | "variant";
  id: string;
  productId: string;
  productTitle: string;
  /** Câte variante devin gestionate prin această schimbare */
  variants: number;
}

export interface StockActivationPreview {
  /** `ready` = se poate aplica; `blocked` = erori, plafon sau nimic de pornit; `warehouse` = gestiunea lipsește */
  status: "ready" | "blocked" | "warehouse";
  fileName: string | null;
  fileHash: string;
  format: "xls" | "xlsx";
  fileDate: string | null;
  warehousesInFile: WarehouseInFile[];
  chosenWarehouses: string[];
  warehouseProblem: { kind: "none_chosen" | "not_found"; message: string } | null;
  takenAt: string | null;
  timeValid: boolean;
  timeWarnings: SnapshotTimeWarning[];
  lastSnapshotAt: string | null;
  /** Motive care blochează aplicarea (poză veche, plafon, nimic de pornit) */
  blockers: string[];
  startUnmatched: boolean;
  maxVariants: number;
  counters: ActivationCounters | null;
  reportCounters: StockReportPlan["counters"] | null;
  planHash: string | null;
  canApply: boolean;
  changes: PreviewListed<ActivationChangeView>;
  enabledMatched: PreviewListed<ActivationVariantRef>;
  enabledZero: PreviewListed<ActivationVariantRef>;
  unmatchedEligible: PreviewListed<ActivationVariantRef>;
  untouched: PreviewListed<UntouchedVariant>;
  errors: PreviewListed<StockReportIssue>;
  warnings: PreviewListed<StockReportWarning>;
  unknownCodes: PreviewListed<{ rowNumber: number; code: string }>;
}

export interface ActivationApplyResult {
  snapshotId: string;
  /** Produse cu cel puțin o variantă pornită */
  enabledProducts: number;
  /** Variante potrivite în fișier, pornite acum */
  enabledVariants: number;
  /** Variante fără potrivire, pornite cu stoc 0 (doar cu opțiunea) */
  startedAtZero: number;
  /** Câte variante au primit o cantitate (din fișier sau 0) */
  applied: number;
  /** Câte angajări de comenzi au fost oglindite de poză */
  mirrored: number;
}

interface Analysis {
  file: StockReportFile;
  settings: StockImportSettings;
  warehouse: { id: string; name: string };
  plan: StockActivationPlan | null;
  titles: Map<string, string>;
  warehouseProblem: StockActivationPreviewWarehouseProblem;
  chosen: string[];
  warehousesInFile: WarehouseInFile[];
  takenAt: Date;
  time: ReturnType<typeof checkSnapshotTime>;
  lastSnapshotAt: Date | null;
  notNewer: string | null;
  startUnmatched: boolean;
}

type StockActivationPreviewWarehouseProblem = StockActivationPreview["warehouseProblem"];

const NOT_NEWER_MESSAGE =
  "Ora raportului nu este mai nouă decât a ultimei sincronizări aplicate. O poză mai veche nu poate înlocui una mai nouă.";

export class StockActivationService {
  constructor(private readonly deps: StockActivationDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get maxVariants(): number {
    return this.deps.maxVariants ?? STOCK_ACTIVATION_MAX_VARIANTS;
  }

  private assertRights(subject: PermissionSubject | null): asserts subject is PermissionSubject {
    assertCan(subject, "products.write");
    assertCan(subject, "inventory.write");
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

  private async analyze(
    bytes: Uint8Array,
    takenAtInput: Date | undefined,
    startUnmatched: boolean,
  ): Promise<Analysis> {
    const settings = await this.deps.settings.read();
    const file = await (this.deps.readFile ?? readStockReportFile)(bytes);
    const warehouse = await this.defaultWarehouse();
    const now = this.now();
    const takenAt = takenAtInput ?? now;
    const chosen = settings.warehouses.filter((name) => normalizeUnitText(name) !== "");
    const warehousesInFile = distinctWarehouses(file, chosen);

    let plan: StockActivationPlan | null = null;
    let warehouseProblem: StockActivationPreviewWarehouseProblem = null;
    const titles = new Map<string, string>();
    try {
      const catalog = await loadReportCatalog(this.deps.db, warehouse.id);
      for (const entry of catalog) titles.set(entry.productId, entry.productTitle);
      plan = planStockActivation({
        rows: file.rows,
        warehouses: chosen,
        catalog,
        startUnmatched,
        maxVariants: this.maxVariants,
      });
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
    const notNewer =
      time.ok && lastSnapshotAt && takenAt.getTime() <= lastSnapshotAt.getTime()
        ? NOT_NEWER_MESSAGE
        : null;
    return {
      file,
      settings,
      warehouse,
      plan,
      titles,
      warehouseProblem,
      chosen,
      warehousesInFile,
      takenAt,
      time,
      lastSnapshotAt,
      notNewer,
      startUnmatched,
    };
  }

  private hashOf(analysis: Analysis & { plan: StockActivationPlan }): string {
    return computeActivationHash({
      fileHash: analysis.file.fileHash,
      warehouses: analysis.chosen,
      startUnmatched: analysis.startUnmatched,
      plan: analysis.plan,
    });
  }

  private blockersOf(analysis: Analysis & { plan: StockActivationPlan }): string[] {
    const { plan } = analysis;
    const blockers: string[] = [];
    if (analysis.notNewer) blockers.push(analysis.notNewer);
    if (plan.tooMany) {
      const total = plan.counters.matched + plan.counters.zero;
      blockers.push(
        `Fișierul ar porni ${total} de variante, iar limita este ${plan.maxVariants} într-o singură aplicare. Împarte raportul sau lasă variantele fără potrivire nepornite.`,
      );
    }
    if (plan.nothingToEnable) {
      blockers.push(
        "Nu e nimic de pornit: variantele din fișier sunt deja gestionate sau neatinse. Pentru cantități folosește importul «stoc la zi».",
      );
    }
    return blockers;
  }

  /** Verificarea fără modificări: ce se pornește, ce rămâne neatins, ce se aplică. */
  async preview(
    subject: PermissionSubject | null,
    input: ActivationPreviewInput,
  ): Promise<StockActivationPreview> {
    this.assertRights(subject);
    const startUnmatched = input.startUnmatched ?? false;
    const analysis = await this.analyze(input.bytes, input.takenAt, startUnmatched);
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
      startUnmatched,
      maxVariants: this.maxVariants,
    };
    const empty = { total: 0, items: [] };
    if (!plan) {
      return {
        ...base,
        status: "warehouse",
        blockers: analysis.notNewer ? [analysis.notNewer] : [],
        counters: null,
        reportCounters: null,
        planHash: null,
        canApply: false,
        changes: empty,
        enabledMatched: empty,
        enabledZero: empty,
        unmatchedEligible: empty,
        untouched: empty,
        errors: empty,
        warnings: empty,
        unknownCodes: empty,
      };
    }
    const withPlan = { ...analysis, plan };
    const blockers = this.blockersOf(withPlan);
    const canApply = plan.canApply && analysis.time.ok && !analysis.notNewer;
    return {
      ...base,
      status: canApply ? "ready" : "blocked",
      blockers,
      counters: plan.counters,
      reportCounters: plan.report.counters,
      planHash: this.hashOf(withPlan),
      canApply,
      changes: listed(plan.changes, (change) => ({
        scope: change.scope,
        id: change.id,
        productId: change.productId,
        productTitle: analysis.titles.get(change.productId) ?? change.productId,
        variants: change.variantIds.length,
      })),
      enabledMatched: listed(plan.enabled.matched, (ref) => ref),
      enabledZero: listed(plan.enabled.zero, (ref) => ref),
      unmatchedEligible: listed(plan.unmatchedEligible, (ref) => ref),
      untouched: listed(plan.untouched, (entry) => entry),
      errors: listed(plan.report.errors, (issue) => issue),
      warnings: listed(plan.report.warnings, (warning) => warning),
      unknownCodes: listed(plan.report.unknownCodes, (entry) => entry),
    };
  }

  /** Aplicarea toată-sau-deloc: bifele și cantitățile, într-o singură tranzacție. */
  async apply(
    subject: PermissionSubject | null,
    input: ActivationApplyInput,
  ): Promise<ActivationApplyResult> {
    this.assertRights(subject);
    const analysis = await this.analyze(input.bytes, input.takenAt, input.startUnmatched);
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
    if (analysis.notNewer) {
      throw new StockError("STOCK_IMPORT_NOT_NEWER", analysis.notNewer, {
        lastSnapshotAt: analysis.lastSnapshotAt?.toISOString() ?? null,
      });
    }
    const withPlan = { ...analysis, plan };
    if (this.hashOf(withPlan) !== input.planHash) {
      throw new StockError(
        "STOCK_IMPORT_PLAN_CHANGED",
        "Fișierul, setările, opțiunea, bifele sau stocul s-au schimbat de la verificare. Verifică din nou înainte de a aplica.",
      );
    }
    if (analysis.time.warnings.length > 0 && !input.acknowledgeTimeWarnings) {
      throw new StockError(
        "STOCK_IMPORT_TIME_NOT_ACKNOWLEDGED",
        "Ora raportului are avertismente: confirmă că ai verificat-o.",
        { kinds: analysis.time.warnings.map((w) => w.kind) },
      );
    }
    // erorile de rând au prioritate: raportul cu erori nu se aplică, oricâte variante ar porni
    if (!plan.report.canApply) selectActivationTargets(plan);
    if (plan.tooMany) {
      throw new StockError(
        "STOCK_ACTIVATION_TOO_MANY",
        this.blockersOf(withPlan).find((text) => text.includes("limita")) ??
          "Fișierul depășește plafonul de variante.",
        { total: plan.counters.matched + plan.counters.zero, max: plan.maxVariants },
      );
    }
    if (plan.nothingToEnable) {
      throw new StockError(
        "STOCK_ACTIVATION_NOTHING_TO_ENABLE",
        "Nu e nimic de pornit: variantele din fișier sunt deja gestionate sau neatinse.",
      );
    }
    checkActivationConfirm(plan, input.confirm);
    const targets = selectActivationTargets(plan);

    const actor = subject;
    const safetyWindowMinutes = analysis.settings.safetyWindowMinutes;
    const now = () => this.now();
    const productIds = plan.changes.filter((c) => c.scope === "product").map((c) => c.id);
    const variantIds = plan.changes.filter((c) => c.scope === "variant").map((c) => c.id);
    const report = {
      ...describeSnapshotReport({
        plan: plan.report,
        zeroedCount: 0,
        timeWarnings: analysis.time.warnings.map((w) => w.kind),
        fileDate: analysis.file.fileDate,
      }),
      activation: {
        enabledProducts: plan.counters.products,
        enabledVariants: plan.counters.matched,
        startedAtZero: plan.counters.zero,
        startUnmatched: input.startUnmatched,
      },
    };

    const outcome = await runStockTransaction(
      this.deps.db,
      async (tx) => {
        // 1) bifele, cu gardă: o bifă schimbată între verificarea amprentei și scriere anulează tot
        for (let at = 0; at < productIds.length; at += UPDATE_CHUNK) {
          const chunk = productIds.slice(at, at + UPDATE_CHUNK);
          const written = await tx.product.updateMany({
            where: { id: { in: chunk }, manageStock: false, deletedAt: null },
            data: { manageStock: true },
          });
          if (written.count !== chunk.length) throw planChanged();
        }
        for (let at = 0; at < variantIds.length; at += UPDATE_CHUNK) {
          const chunk = variantIds.slice(at, at + UPDATE_CHUNK);
          const written = await tx.productVariant.updateMany({
            where: { id: { in: chunk }, manageStock: null, product: { deletedAt: null } },
            data: { manageStock: true },
          });
          if (written.count !== chunk.length) throw planChanged();
        }
        // 2) poza și cantitățile, în ordinea fixă de blocare
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

    await this.audit(
      actor,
      analysis,
      plan,
      input,
      outcome.snapshotId,
      outcome.mirrored,
      targets.length,
    );
    try {
      await this.deps.invalidate?.([CATALOG_TAG]);
    } catch {
      // un eșec al invalidării nu anulează scrierea (cache-ul expiră oricum)
    }
    return {
      snapshotId: outcome.snapshotId,
      enabledProducts: plan.counters.products,
      enabledVariants: plan.counters.matched,
      startedAtZero: plan.counters.zero,
      applied: targets.length,
      mirrored: outcome.mirrored,
    };
  }

  /** Un eveniment agregat și câte un rând per produs sau variantă pornită (o singură inserare în lot). */
  private async audit(
    actor: PermissionSubject,
    analysis: Analysis,
    plan: StockActivationPlan,
    input: ActivationApplyInput,
    snapshotId: string,
    mirrored: number,
    applied: number,
  ): Promise<void> {
    const rows: AuditInput[] = [
      {
        actorId: actor.userId,
        actorLabel: actor.email,
        action: "stock.activation.apply",
        entity: "stock_snapshot",
        entityId: snapshotId,
        after: {
          fileName: input.fileName,
          fileHash: analysis.file.fileHash,
          takenAt: analysis.takenAt.toISOString(),
          warehouse: analysis.warehouse.name,
          warehousesRead: plan.report.warehousesRead,
          startUnmatched: input.startUnmatched,
          enabledProducts: plan.counters.products,
          enabledVariants: plan.counters.matched,
          startedAtZero: plan.counters.zero,
          applied,
          mirrored,
          alreadyManaged: plan.counters.alreadyManaged,
          counters: plan.report.counters,
          timeWarnings: analysis.time.warnings.map((w) => w.kind),
        },
      },
      ...plan.changes.map((change): AuditInput => ({
        actorId: actor.userId,
        actorLabel: actor.email,
        action: "stock.activation.enable",
        entity: change.scope === "product" ? "product" : "product_variant",
        entityId: change.id,
        before: { manageStock: change.scope === "product" ? false : null },
        after: {
          manageStock: true,
          scope: change.scope,
          variants: change.variantIds.length,
          snapshotId,
        },
      })),
    ];
    await this.deps.audit.recordMany(rows);
  }
}

function planChanged(): StockError {
  return new StockError(
    "STOCK_IMPORT_PLAN_CHANGED",
    "O bifă de stoc s-a schimbat de la verificare. Verifică din nou înainte de a aplica.",
  );
}

function defaultStock(tx: Db, now: () => Date): StockSnapshotApplier {
  return new StockService({ db: tx, now });
}
