import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { StorageDriver } from "@ecom/integrations";
import { DomainError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../../audit/audit-service";
import { assertCan, can, type PermissionSubject } from "../../rbac/can";
import { SHIPPING_CLASSES } from "../constants";
import { CATALOG_TAG } from "../catalog-support";
import type { ProductAssignmentsService } from "../product-assignments";
import { parseInput } from "../product-schemas";
import type { ProductService } from "../product-service";
import {
  IMPORT_FIELD_KEYS,
  foldText,
  isCostLikeFieldKey,
  suggestMapping,
  type ImportFieldKey,
  type SuggestedColumn,
} from "./import-fields";
import {
  CSV_DELIMITERS,
  parseImportFile,
  type CsvDelimiter,
  type ImportFormat,
  type ImportLimits,
  type ParsedTable,
} from "./import-file";
import {
  ImportMappingError,
  collectLookups,
  planImport,
  type ImportCounts,
  type ImportMapping,
  type ImportPlan,
  type PlannedRow,
} from "./import-plan";
import { WooApplier, type WooApplyDeps } from "./woo/woo-apply";
import { describeWoo, type WooAnalysis } from "./woo/woo-analysis";
import { detectWooColumns, looksLikeWooExport } from "./woo/woo-columns";
import { collectWooLookups, planWoo } from "./woo/woo-plan";
import { imageFailureMessage, type ImageImportPolicy } from "./woo/image-importer";
import type { ImageFailure, ImageProgress } from "./woo/image-store";
import { WOO_IMAGE_MESSAGES } from "./woo/woo-plan";
import { REPORT_IMAGE_ISSUES, type WooOptions } from "./woo/woo-types";
import {
  APPLIED_STATUSES,
  REPORT_ENTRY_LIMIT,
  isWooMapping,
  type ImportHistoryRow,
  type ImportMappingRecord,
  type ImportSummary,
  type ImportRecord,
  type ImportReport,
  type ImportReportEntry,
  type ProductImportStore,
} from "./import-store";

/**
 * Importul de produse (CSV/XLSX), de la încărcare la aplicare.
 *
 *  1. `register`: fișierul se citește, se verifică (format real, limite) și se stochează PRIVAT sub o
 *     cheie generată de server; nu se atinge catalogul.
 *  2. `validate` (dry-run): fișierul stocat + maparea → plan; se salvează amprenta planului. Nu scrie
 *     nimic în catalog.
 *  3. `apply`: reverifică hash-ul fișierului și recalculează planul față de starea CURENTĂ a catalogului;
 *     dacă amprenta nu coincide cu cea verificată, refuză (reia verificarea). Până la `syncMaxRows`
 *     rânduri se aplică pe loc, peste se pune un job în coadă (`runQueued`), cu progres.
 *
 * Rândurile se aplică pe rând, fiecare prin serviciile obișnuite ale catalogului (cu audit tăcut): o
 * eroare pe un rând nu oprește restul. UN singur eveniment de audit `product.import` cu numere agregate.
 * Toate operațiile cer `products.write` și aparțin utilizatorului care a încărcat fișierul; jobul din
 * fundal reîncarcă subiectul și reverifică permisiunea. Prețul de achiziție nu se importă: o coloană
 * de cost mapată se refuză.
 */

export class ImportError extends DomainError {}

export interface ImportSettings extends ImportLimits {
  maxUploadBytes: number;
  syncMaxRows: number;
  retentionHours: number;
  /** Zile de păstrare a raportului detaliat al importurilor aplicate (istoric). */
  historyRetentionDays: number;
  /** Minute fără progres după care un import care rulează apare ca «întrerupt». */
  interruptedAfterMinutes: number;
}

export interface ImportJobQueue {
  enqueue(importId: string): Promise<void>;
}

/** Coada descărcării imaginilor unui import (job separat, în worker). */
export interface ImageJobQueue {
  enqueue(importId: string): Promise<void>;
}

/** Setările importului de imagini (`imageImport`), citite FĂRĂ cache: lista de domenii e o setare de securitate. */
export type ImageImportSettings = ImageImportPolicy & {
  maxImagesPerProduct: number;
  maxImagesPerImport: number;
};

export interface ProductImportDeps {
  store: ProductImportStore;
  storage: Pick<StorageDriver, "put" | "get" | "delete">;
  audit: AuditService;
  /**
   * Colectorul auditului pe entitate (C-12): evenimentele serviciilor de mai jos (create/update/…) se strâng cât rulează
   * importul și se scriu la sfârșit, marcate cu `importId`; fără el, ele nu lasă urme pe rând.
   */
  rowAudit?: { run<T>(importId: string, fn: () => Promise<T>): Promise<T> };
  /** Serviciile catalogului; auditul lor trece prin `rowAudit`, iar importul scrie și evenimentul agregat. */
  products: Pick<ProductService, "create" | "update" | "updateVariant"> &
    Partial<Pick<ProductService, "createVariable">>;
  assignments: Pick<ProductAssignmentsService, "setCategories">;
  /** Serviciile profilului WooCommerce (categorii, branduri, atribute, relații); fără ele profilul e indisponibil. */
  woo?: Pick<
    WooApplyDeps,
    "categories" | "brands" | "attributeDefs" | "attributeValues" | "relations"
  > & {
    getTimezone: () => Promise<string>;
  };
  getSettings: () => Promise<ImportSettings>;
  /** Pentru jobul din fundal: utilizatorul care a pornit importul, cu permisiunile curente. */
  loadSubject?: (userId: string) => Promise<PermissionSubject | null>;
  queue?: ImportJobQueue;
  /** Fără ea, imaginile se verifică, dar descărcarea nu pornește singură (se reia cu «Reia imaginile»). */
  imageQueue?: ImageJobQueue;
  /** Setările importului de imagini; fără ele, importul de imagini e indisponibil. */
  getImageSettings?: () => Promise<ImageImportSettings>;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn" | "error">;
  now?: () => Date;
}

export interface ImportAnalysis {
  importId: string;
  fileName: string;
  format: ImportFormat;
  delimiter: CsvDelimiter | null;
  /** De unde vine delimitatorul: linia «sep=» a fișierului, alegerea ta sau detectarea. */
  delimiterSource: "sep-line" | "chosen" | "detected" | null;
  encoding: "utf-16le" | "utf-8" | "windows-1250" | null;
  headers: string[];
  /** Primele rânduri de date, cu celulele scurtate, pentru previzualizare. */
  sample: string[][];
  rowCount: number;
  columns: SuggestedColumn[];
  warnings: string[];
  /** Fișierul arată ca un export WooCommerce: ce conține și opțiunile propuse pentru profilul WooCommerce. */
  woo: WooAnalysis | null;
}

export interface ImportValidation {
  importId: string;
  planHash: string;
  rowCount: number;
  report: ImportReport;
  /** Se aplică pe loc (sincron) sau în fundal. */
  mode: "sync" | "background";
}

/** Progresul descărcării imaginilor unui import (din sarcinile lui). */
export interface ImageProgressView {
  total: number;
  pending: number;
  downloaded: number;
  existing: number;
  failed: number;
  /** «în curs» = ceva s-a mișcat recent; «întrerupt» = sunt imagini în așteptare, dar nimic nu avansează. */
  state: "running" | "interrupted" | "done";
}

export interface ImportStatusView {
  importId: string;
  images: ImageProgressView | null;
  status: ImportRecord["status"];
  rowCount: number;
  processedRows: number;
  summary: ImportCounts | null;
  report: ImportReport | null;
  errorMessage: string | null;
}

/** Starea unui import în istoric: «întrerupt» = rulează în baza de date, dar n-a mai avansat de mult. */
export type ImportHistoryState = "running" | "completed" | "failed" | "interrupted";

export interface ImportHistoryItem {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  state: ImportHistoryState;
  fileName: string;
  format: ImportFormat;
  profile: "generic" | "woocommerce";
  userName: string | null;
  userEmail: string | null;
  rowCount: number;
  /** Rânduri aplicate până acum (la un import întrerupt: cel puțin atâtea). */
  processedRows: number;
  /** Contoarele finale (doar la importurile terminate). */
  counts: ImportSummary | null;
  /** Motivul eșecului (doar la importurile eșuate). */
  errorMessage: string | null;
  /** Imaginile aduse din adrese: progres și rezultat (null dacă importul n-a avut imagini). */
  images: ImageProgressView | null;
  /** Raportul detaliat pe rânduri mai există; altfel a fost șters după perioada de păstrare. */
  hasReport: boolean;
  /** Până când se păstrează raportul detaliat (null dacă a fost deja șters). */
  reportUntil: Date | null;
}

export interface ImportHistoryPage {
  items: ImportHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  retentionDays: number;
}

export interface ImportHistoryDetail {
  item: ImportHistoryItem;
  /** Raportul final pe rânduri; `null` dacă importul nu e terminat sau detaliul a fost șters. */
  report: ImportReport | null;
  retentionDays: number;
}

export const HISTORY_PAGE_SIZE = 25;

const PREVIEW_ROWS = 5;
const PREVIEW_CELL = 80;
const PROGRESS_EVERY = 10;
const PURGE_BATCH = 50;
const STORAGE_PREFIX = "private/product-imports/";

const columnsSchema = z.array(z.enum(IMPORT_FIELD_KEYS).nullable()).min(1).max(200);
const validateSchema = z.strictObject({
  importId: z.string().min(1).max(40),
  columns: columnsSchema,
  delimiter: z.enum([",", ";", "\t"]).nullable().optional(),
});
const wooOptionsSchema = z.strictObject({
  keepStatus: z.boolean(),
  weightUnit: z.enum(["kg", "g"]),
  dimensionUnit: z.enum(["cm", "mm", "m"]),
  shippingClassMap: z.record(z.string().min(1).max(100), z.enum(SHIPPING_CLASSES)),
  attributeTargets: z.record(z.string().min(1).max(100), z.string().min(1).max(60)),
  importImages: z.boolean().default(false),
});
const wooValidateSchema = z.strictObject({
  importId: z.string().min(1).max(40),
  profile: z.literal("woocommerce"),
  options: wooOptionsSchema,
  delimiter: z.enum([",", ";", "\t"]).nullable().optional(),
});

/** Cheile din opțiuni se normalizează ca în fișier (fără majuscule și diacritice). */
function normalizeWooOptions(options: z.output<typeof wooOptionsSchema>): WooOptions {
  const fold = (map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([key, value]) => [foldText(key), value]));
  return {
    keepStatus: options.keepStatus,
    weightUnit: options.weightUnit,
    dimensionUnit: options.dimensionUnit,
    shippingClassMap: fold(options.shippingClassMap) as WooOptions["shippingClassMap"],
    attributeTargets: fold(options.attributeTargets),
    importImages: options.importImages,
  };
}

const applySchema = z.strictObject({
  importId: z.string().min(1).max(40),
  confirm: z.literal(true, { error: "Confirmarea explicită lipsește" }),
  expectedPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function readAll(stream: Readable, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > max) throw new ImportError("IMPORT_FILE_CHANGED", "Fișierul stocat s-a schimbat");
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

const OUTCOME_LABEL: Record<ImportReportEntry["outcome"], string> = {
  new: "nou",
  updated: "actualizat",
  unchanged: "neschimbat",
  skipped: "ignorat",
  error: "eroare",
};

/** Raportul unui plan (sau al unui plan aplicat, cu rezultatele finale pe rând). */
export function buildReport(
  plan: ImportPlan,
  finalRows: readonly PlannedRow[] = plan.rows,
  counts: ImportCounts = plan.counts,
): ImportReport {
  const entries: ImportReportEntry[] = finalRows
    .filter((r) => r.outcome !== "unchanged")
    .map((r) => ({
      row: r.row,
      sku: r.sku,
      outcome: r.outcome,
      messages: r.messages.map((m) => m.text),
      changed: r.changed,
    }));
  // dacă raportul se taie, rămân întâi erorile, apoi restul, în ordinea rândurilor
  const ordered = [
    ...entries.filter((e) => e.outcome === "error"),
    ...entries.filter((e) => e.outcome !== "error"),
  ];
  return {
    counts,
    fileWarnings: plan.fileWarnings,
    entries: ordered.slice(0, REPORT_ENTRY_LIMIT),
    truncated: ordered.length > REPORT_ENTRY_LIMIT,
    ...(plan.woo && {
      woo: {
        categoriesToCreate: plan.woo.creations.categories.map((c) => c.names.join(" > ")),
        brandsToCreate: plan.woo.creations.brands.map((b) => b.name),
        attributesToCreate: plan.woo.creations.attributes.map((a) => a.name),
        images: {
          enabled: plan.woo.images.enabled,
          stats: plan.woo.images.stats,
          issues: plan.woo.images.issues.slice(0, REPORT_IMAGE_ISSUES).map((issue) => ({
            row: issue.row,
            sku: issue.sku,
            host: issue.host,
            message: WOO_IMAGE_MESSAGES[issue.reason] ?? "adresă respinsă",
          })),
          issuesTruncated: plan.woo.images.issues.length > REPORT_IMAGE_ISSUES,
        },
        stats: plan.woo.stats,
        rowTypes: plan.woo.rowTypes,
        ignoredColumns: plan.woo.ignoredColumns,
        blockedColumns: plan.woo.blockedColumns,
      },
    }),
  };
}

export class ProductImportService {
  constructor(private readonly deps: ProductImportDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async limits(): Promise<ImportSettings> {
    return this.deps.getSettings();
  }

  private async own(subject: PermissionSubject, importId: string): Promise<ImportRecord> {
    const record = await this.deps.store.get(importId);
    if (!record || record.createdById !== subject.userId) {
      throw new ImportError("IMPORT_NOT_FOUND", "Importul nu există sau a expirat");
    }
    return record;
  }

  private async readStored(record: ImportRecord): Promise<Uint8Array> {
    if (!record.storageKey) {
      throw new ImportError(
        "IMPORT_NOT_FOUND",
        "Fișierul importului a fost șters; încarcă-l din nou",
      );
    }
    const { stream } = await this.deps.storage.get(record.storageKey);
    const bytes = await readAll(stream, record.sizeBytes + 1);
    if (bytes.length !== record.sizeBytes || sha256(bytes) !== record.fileHash) {
      throw new ImportError(
        "IMPORT_FILE_CHANGED",
        "Fișierul stocat s-a schimbat; încarcă-l din nou",
      );
    }
    return bytes;
  }

  private async deleteFile(key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.deps.storage.delete(key);
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "import: fișierul nu s-a șters din stocare (expiră oricum)",
      );
    }
  }

  /** Șterge raportul detaliat al importurilor aplicate după perioada de păstrare (sumarul rămâne). */
  async purgeReportDetails(): Promise<number> {
    try {
      return await this.deps.store.purgeReports(this.now());
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "import: purjarea rapoartelor vechi a eșuat",
      );
      return 0;
    }
  }

  /** Progresul imaginilor: «întrerupt» când sunt imagini în așteptare și nimic nu s-a mișcat de mult. */
  private imageView(
    progress: ImageProgress | undefined,
    settings: ImportSettings,
  ): ImageProgressView | null {
    if (!progress) return null;
    const total = progress.pending + progress.downloaded + progress.existing + progress.failed;
    if (total === 0) return null;
    const idleMs = progress.lastActivity
      ? this.now().getTime() - progress.lastActivity.getTime()
      : 0;
    const state: ImageProgressView["state"] =
      progress.pending === 0
        ? "done"
        : idleMs > settings.interruptedAfterMinutes * 60_000
          ? "interrupted"
          : "running";
    return {
      total,
      pending: progress.pending,
      downloaded: progress.downloaded,
      existing: progress.existing,
      failed: progress.failed,
      state,
    };
  }

  private historyItem(
    row: ImportHistoryRow,
    settings: ImportSettings,
    images: ImageProgress | undefined,
  ): ImportHistoryItem {
    const idleMs = this.now().getTime() - row.updatedAt.getTime();
    const state: ImportHistoryState =
      row.status === "completed"
        ? "completed"
        : row.status === "failed"
          ? "failed"
          : idleMs > settings.interruptedAfterMinutes * 60_000
            ? "interrupted"
            : "running";
    return {
      id: row.id,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      state,
      fileName: row.fileName,
      format: row.format,
      profile: isWooMapping(row.mapping) ? "woocommerce" : "generic",
      userName: row.userName,
      userEmail: row.userEmail,
      rowCount: row.rowCount,
      processedRows: row.processedRows,
      counts: state === "completed" ? row.summary : null,
      images: state === "completed" ? this.imageView(images, settings) : null,
      errorMessage: state === "failed" ? row.errorMessage : null,
      hasReport: state === "completed" && row.hasReport,
      reportUntil:
        state === "completed" && row.hasReport && row.finishedAt
          ? new Date(row.finishedAt.getTime() + settings.historyRetentionDays * 86_400_000)
          : null,
    };
  }

  /** Istoricul importurilor aplicate (ale tuturor utilizatorilor), cele mai noi întâi. Cere `products.write`. */
  async listHistory(subject: PermissionSubject | null, page: number): Promise<ImportHistoryPage> {
    assertCan(subject, "products.write");
    await this.purgeReportDetails();
    const settings = await this.limits();
    const safePage = Number.isInteger(page) && page > 0 ? Math.min(page, 100_000) : 1;
    const { rows, total } = await this.deps.store.listApplied({
      skip: (safePage - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE,
    });
    const progress = await this.deps.store.images.progress(rows.map((row) => row.id));
    return {
      items: rows.map((row) => this.historyItem(row, settings, progress.get(row.id))),
      total,
      page: safePage,
      pageSize: HISTORY_PAGE_SIZE,
      pageCount: Math.max(Math.ceil(total / HISTORY_PAGE_SIZE), 1),
      retentionDays: settings.historyRetentionDays,
    };
  }

  /** Un import din istoric, cu raportul final pe rânduri (dacă mai există). Cere `products.write`. */
  async getHistory(
    subject: PermissionSubject | null,
    importId: string,
  ): Promise<ImportHistoryDetail> {
    assertCan(subject, "products.write");
    await this.purgeReportDetails();
    const settings = await this.limits();
    const found = await this.deps.store.getApplied(importId);
    if (!found) throw new ImportError("IMPORT_NOT_FOUND", "Importul nu există în istoric");
    const progress = await this.deps.store.images.progress([importId]);
    const item = this.historyItem(found.row, settings, progress.get(importId));
    return {
      item,
      report: item.state === "completed" ? found.report : null,
      retentionDays: settings.historyRetentionDays,
    };
  }

  /** Șterge importurile expirate (fișier + rând); se cheamă la fiecare încărcare nouă. */
  async purgeExpired(): Promise<number> {
    const expired = await this.deps.store.findExpired(this.now(), PURGE_BATCH);
    for (const item of expired) {
      await this.deleteFile(item.storageKey);
      await this.deps.store.delete(item.id);
    }
    return expired.length;
  }

  private async analysisOf(
    record: ImportRecord,
    table: ParsedTable,
    subject: PermissionSubject,
  ): Promise<ImportAnalysis> {
    const detected = detectWooColumns(table.headers);
    let woo: WooAnalysis | null = null;
    if (looksLikeWooExport(detected)) {
      const canImport = can(subject, "media.write") && !!this.deps.getImageSettings;
      const imageSettings =
        canImport && this.deps.getImageSettings ? await this.deps.getImageSettings() : null;
      woo = describeWoo(table, await this.deps.store.woo.listAttributes(), detected, {
        allowedHosts: imageSettings?.allowedHosts ?? [],
        canImport,
      });
    }
    return {
      importId: record.id,
      fileName: record.fileName,
      format: table.format,
      delimiter: table.delimiter,
      delimiterSource: table.delimiterSource,
      encoding: table.encoding,
      headers: table.headers,
      sample: table.rows
        .slice(0, PREVIEW_ROWS)
        .map((row) =>
          row.map((cell) =>
            cell.length > PREVIEW_CELL ? `${cell.slice(0, PREVIEW_CELL)}…` : cell,
          ),
        ),
      rowCount: table.rows.length,
      columns: suggestMapping(table.headers),
      warnings: table.warnings,
      woo,
    };
  }

  /** Pasul 1: stochează fișierul și îl analizează (antet, previzualizare, mapare propusă). */
  async register(
    subject: PermissionSubject | null,
    input: { bytes: Uint8Array; fileName: string },
  ): Promise<ImportAnalysis> {
    assertCan(subject, "products.write");
    const settings = await this.limits();
    await this.purgeReportDetails().catch(() => undefined);
    await this.purgeExpired().catch((error: unknown) => {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "import: curățarea importurilor expirate a eșuat",
      );
    });

    const table = await parseImportFile(input.bytes, settings);
    const key = `${STORAGE_PREFIX}${randomUUID()}.${table.format}`;
    await this.deps.storage.put(key, Buffer.from(input.bytes), {
      contentType: "application/octet-stream",
      cacheControl: "private, no-store",
    });
    try {
      const record = await this.deps.store.create({
        createdById: subject.userId,
        fileName: input.fileName,
        format: table.format,
        sizeBytes: input.bytes.length,
        fileHash: sha256(input.bytes),
        storageKey: key,
        delimiter: table.delimiter,
        rowCount: table.rows.length,
        expiresAt: new Date(this.now().getTime() + settings.retentionHours * 3_600_000),
      });
      return await this.analysisOf(record, table, subject);
    } catch (error) {
      await this.deleteFile(key);
      throw error;
    }
  }

  /** Reanalizează fișierul cu alt delimitator (pasul de mapare). */
  async analyze(
    subject: PermissionSubject | null,
    importId: string,
    options: { delimiter?: CsvDelimiter } = {},
  ): Promise<ImportAnalysis> {
    assertCan(subject, "products.write");
    const record = await this.own(subject, importId);
    if (record.status !== "uploaded" && record.status !== "validated") {
      throw new ImportError("IMPORT_STATE_INVALID", "Importul a pornit deja");
    }
    const bytes = await this.readStored(record);
    const delimiter =
      options.delimiter && CSV_DELIMITERS.includes(options.delimiter)
        ? options.delimiter
        : undefined;
    const table = await parseImportFile(bytes, await this.limits(), delimiter ? { delimiter } : {});
    return this.analysisOf(record, table, subject);
  }

  private mappingOf(columns: readonly (ImportFieldKey | null)[]): ImportMapping {
    return { columns };
  }

  private async planFor(
    record: ImportRecord,
    mapping: ImportMappingRecord,
    delimiter: CsvDelimiter | undefined,
    subject: PermissionSubject,
  ): Promise<{ table: ParsedTable; plan: ImportPlan }> {
    const bytes = await this.readStored(record);
    const table = await parseImportFile(bytes, await this.limits(), delimiter ? { delimiter } : {});
    if (isWooMapping(mapping)) {
      if (!this.deps.woo) {
        throw new ImportError(
          "IMPORT_PROFILE_UNAVAILABLE",
          "Profilul WooCommerce nu este disponibil",
        );
      }
      const snapshot = await this.deps.store.loadWooSnapshot(collectWooLookups(table));
      const imageSettings =
        can(subject, "media.write") && this.deps.getImageSettings
          ? await this.deps.getImageSettings()
          : null;
      const plan = planWoo(table, mapping.options, snapshot, {
        images: imageSettings && {
          allowedHosts: imageSettings.allowedHosts,
          maxUrlLength: imageSettings.maxUrlLength,
          maxImagesPerProduct: imageSettings.maxImagesPerProduct,
          maxImagesPerImport: imageSettings.maxImagesPerImport,
        },
        timezone: await this.deps.woo.getTimezone(),
        canSetLegacy: can(subject, "catalog.legacy.edit"),
      });
      return { table, plan };
    }
    const generic = this.mappingOf(mapping);
    const snapshot = await this.deps.store.loadSnapshot(collectLookups(table, generic));
    return { table, plan: planImport(table, generic, snapshot) };
  }

  /** Pasul 3 (dry-run): planifică fără să scrie nimic în catalog și salvează maparea și amprenta. */
  async validate(subject: PermissionSubject | null, input: unknown): Promise<ImportValidation> {
    assertCan(subject, "products.write");
    const rawColumns = (input as { columns?: unknown } | null)?.columns;
    if (
      Array.isArray(rawColumns) &&
      rawColumns.some((c) => typeof c === "string" && isCostLikeFieldKey(c))
    ) {
      throw new ImportMappingError(
        "IMPORT_MAPPING_COST",
        "Prețul de achiziție nu se importă și nu poate fi mapat pe niciun câmp.",
      );
    }
    const wooRequest =
      (input as { profile?: unknown } | null)?.profile === "woocommerce"
        ? parseInput(wooValidateSchema, input)
        : null;
    const genericRequest = wooRequest ? null : parseInput(validateSchema, input);
    const request = (wooRequest ?? genericRequest) as {
      importId: string;
      delimiter?: string | null;
    };
    const record = await this.own(subject, request.importId);
    if (record.status !== "uploaded" && record.status !== "validated") {
      throw new ImportError("IMPORT_STATE_INVALID", "Importul a pornit deja");
    }
    const delimiter = (request.delimiter ?? undefined) as CsvDelimiter | undefined;
    const mapping: ImportMappingRecord = wooRequest
      ? { profile: "woocommerce", options: normalizeWooOptions(wooRequest.options) }
      : [...(genericRequest as z.output<typeof validateSchema>).columns];
    const { table, plan } = await this.planFor(record, mapping, delimiter, subject);

    const report = buildReport(plan);
    await this.deps.store.update(record.id, {
      status: "validated",
      mapping,
      delimiter: delimiter ?? record.delimiter,
      planHash: plan.fingerprint,
      rowCount: table.rows.length,
      processedRows: 0,
      summary: plan.counts,
      report,
      errorMessage: null,
    });
    const settings = await this.limits();
    return {
      importId: record.id,
      planHash: plan.fingerprint,
      rowCount: table.rows.length,
      report,
      mode: table.rows.length <= settings.syncMaxRows || !this.deps.queue ? "sync" : "background",
    };
  }

  /** Pasul 4: aplică exact ce s-a verificat; sincron sau în fundal. */
  async apply(
    subject: PermissionSubject | null,
    input: unknown,
  ): Promise<{ mode: "sync"; report: ImportReport } | { mode: "background" }> {
    assertCan(subject, "products.write");
    const request = parseInput(applySchema, input);
    const record = await this.own(subject, request.importId);
    if (record.status !== "validated" || !record.mapping || !record.planHash) {
      throw new ImportError("IMPORT_STATE_INVALID", "Verifică importul înainte să-l aplici");
    }
    if (record.planHash !== request.expectedPlanHash) {
      throw new ImportError(
        "IMPORT_STALE",
        "Verificarea afișată nu mai corespunde importului; reia verificarea",
      );
    }
    const delimiter = (record.delimiter ?? undefined) as CsvDelimiter | undefined;
    const { plan } = await this.planFor(record, record.mapping, delimiter, subject);
    if (plan.fingerprint !== record.planHash) {
      throw new ImportError(
        "IMPORT_STALE",
        "Catalogul s-a schimbat de la verificare (sau fișierul nu mai corespunde). Reia verificarea, apoi aplică.",
      );
    }
    if (plan.counts.new + plan.counts.updated === 0 && (plan.woo?.images.tasks.length ?? 0) === 0) {
      throw new ImportError(
        "IMPORT_NOTHING_TO_APPLY",
        "Nu există nimic de aplicat: niciun rând nou sau modificat",
      );
    }

    const settings = await this.limits();
    if (record.rowCount <= settings.syncMaxRows || !this.deps.queue) {
      if (!(await this.deps.store.transition(record.id, ["validated"], "running"))) {
        throw new ImportError("IMPORT_STATE_INVALID", "Importul a pornit deja");
      }
      const report = await this.execute(record, subject, plan);
      return { mode: "sync", report };
    }

    if (!(await this.deps.store.transition(record.id, ["validated"], "queued"))) {
      throw new ImportError("IMPORT_STATE_INVALID", "Importul a pornit deja");
    }
    try {
      await this.deps.queue.enqueue(record.id);
    } catch (error) {
      await this.deps.store.transition(record.id, ["queued"], "validated");
      this.deps.logger.error(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "import: coada de joburi nu e disponibilă",
      );
      throw new ImportError(
        "IMPORT_QUEUE_UNAVAILABLE",
        "Coada de joburi nu e disponibilă momentan; încearcă din nou",
      );
    }
    return { mode: "background" };
  }

  /** Intrarea jobului din fundal: reîncarcă subiectul, reverifică permisiunea și rulează importul. */
  async runQueued(importId: string): Promise<void> {
    const record = await this.deps.store.get(importId);
    if (!record || (record.status !== "queued" && record.status !== "running")) return;
    const resuming = record.status === "running";
    if (!resuming && !(await this.deps.store.transition(importId, ["queued"], "running"))) return;

    const fail = async (message: string) => {
      await this.deps.store.update(importId, {
        status: "failed",
        errorMessage: message,
        finishedAt: this.now(),
        storageKey: null,
        expiresAt: new Date(
          this.now().getTime() + (await this.limits()).historyRetentionDays * 86_400_000,
        ),
      });
      await this.deleteFile(record.storageKey);
    };

    const subject =
      record.createdById && this.deps.loadSubject
        ? await this.deps.loadSubject(record.createdById)
        : null;
    if (!subject || !can(subject, "products.write")) {
      await fail("Contul care a pornit importul nu mai are permisiunea de a modifica produse.");
      return;
    }
    try {
      if (!record.mapping) throw new ImportError("IMPORT_STATE_INVALID", "Importul nu are mapare");
      const delimiter = (record.delimiter ?? undefined) as CsvDelimiter | undefined;
      const { plan } = await this.planFor(record, record.mapping, delimiter, subject);
      // la prima pornire, planul trebuie să fie cel verificat; la reluare (job căzut la mijloc) o parte
      // din rânduri sunt deja aplicate, deci planul diferă firesc și se continuă cu starea curentă
      if (!resuming && plan.fingerprint !== record.planHash) {
        await fail("Catalogul s-a schimbat de la verificare. Reia verificarea și aplică din nou.");
        return;
      }
      await this.execute(record, subject, plan);
    } catch (error) {
      this.deps.logger.error(
        {
          reason: error instanceof Error ? error.message : "necunoscut",
          code: (error as { code?: unknown })?.code,
        },
        "import: jobul din fundal a eșuat",
      );
      await fail(
        "Importul a eșuat neașteptat. Reia verificarea și aplică din nou; rândurile deja aplicate rămân neschimbate.",
      );
    }
  }

  /** Aplică planul rând cu rând, fiecare izolat; scrie raportul final, șterge fișierul și auditează o singură dată. */
  /** Rulează planul; evenimentele de audit pe entitate se colectează și se scriu la sfârșit, marcate cu `importId` (C-12). */
  private execute(
    record: ImportRecord,
    subject: PermissionSubject,
    plan: ImportPlan,
  ): Promise<ImportReport> {
    const run = () => this.executePlan(record, subject, plan);
    return this.deps.rowAudit ? this.deps.rowAudit.run(record.id, run) : run();
  }

  private async executePlan(
    record: ImportRecord,
    subject: PermissionSubject,
    plan: ImportPlan,
  ): Promise<ImportReport> {
    const startedAt = this.now();
    await this.deps.store.update(record.id, { startedAt, processedRows: 0 });

    const woo = plan.woo ? this.wooApplier() : null;
    const wooRun = woo ? await woo.prepare(subject, plan) : null;
    const finalRows: PlannedRow[] = [];
    let done = 0;
    for (const row of plan.rows) {
      if (row.op && woo && wooRun && row.op.kind.startsWith("woo-")) {
        finalRows.push(await woo.applyRow(subject, row, wooRun));
      } else {
        finalRows.push(row.op ? await this.applyRow(subject, row) : row);
      }
      done++;
      if (done % PROGRESS_EVERY === 0) {
        await this.deps.store.update(record.id, { processedRows: done });
      }
    }

    if (woo && wooRun) {
      // relațiile, într-o a doua trecere: toate produsele din fișier există acum
      const warnings = await woo.finish(subject, wooRun);
      for (let i = 0; i < finalRows.length; i++) {
        const row = finalRows[i] as PlannedRow;
        const extra = warnings.get(row.row) ?? [];
        const already = new Set(row.messages.map((m) => m.text));
        const fresh = extra.filter((text) => !already.has(text));
        if (fresh.length > 0) {
          finalRows[i] = {
            ...row,
            messages: [
              ...row.messages,
              ...fresh.map((text) => ({ level: "warning" as const, text })),
            ],
          };
        }
      }
    }

    // imaginile: sarcinile se salvează acum; descărcarea rulează apoi în fundal (nu blochează produsele)
    const imageTasks = await this.createImageTasks(record.id, plan, finalRows);

    const counts: ImportCounts = {
      new: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    };
    for (const r of finalRows) {
      if (r.outcome === "new") counts.new++;
      else if (r.outcome === "updated") counts.updated++;
      else if (r.outcome === "unchanged") counts.unchanged++;
      else if (r.outcome === "skipped") counts.skipped++;
      else counts.errors++;
      counts.warnings += r.messages.filter((m) => m.level === "warning").length;
    }
    const report = buildReport(plan, finalRows, counts);

    // entitățile create de profilul WooCommerce (planificate minus cele care n-au putut fi create)
    const created =
      plan.woo && wooRun
        ? {
            categories: plan.woo.creations.categories.filter((c) => wooRun.categoryId.has(c.key))
              .length,
            brands: plan.woo.creations.brands.filter((b) => wooRun.brandId.has(b.key)).length,
            attributes: plan.woo.creations.attributes.filter((a) => wooRun.attributeId.has(a.key))
              .length,
          }
        : null;
    const imageStats = plan.woo?.images.stats;
    const images =
      imageStats && imageStats.total > 0
        ? {
            total: imageStats.total,
            accepted: imageStats.accepted,
            rejected: imageStats.rejected,
            queued: imageTasks,
          }
        : null;
    const finishedAt = this.now();
    await this.deps.store.update(record.id, {
      status: "completed",
      processedRows: plan.rows.length,
      summary: { ...counts, ...(created && { created }), ...(images && { images }) },
      report,
      finishedAt,
      storageKey: null,
      // importul aplicat rămâne în istoric; raportul detaliat se păstrează `historyRetentionDays`
      expiresAt: new Date(
        finishedAt.getTime() + (await this.limits()).historyRetentionDays * 86_400_000,
      ),
    });
    await this.deleteFile(record.storageKey);

    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.import",
      entity: "product_import",
      entityId: record.id,
      after: {
        format: record.format,
        rows: plan.rows.length,
        created: counts.new,
        updated: counts.updated,
        unchanged: counts.unchanged,
        skipped: counts.skipped,
        errors: counts.errors,
        ...(created && {
          createdCategories: created.categories,
          createdBrands: created.brands,
          createdAttributes: created.attributes,
        }),
        ...(images && {
          imagesTotal: images.total,
          imagesRejected: images.rejected,
          imagesQueued: images.queued,
        }),
        background: record.status === "queued" || record.status === "running",
      },
    });
    try {
      await this.deps.invalidate?.([CATALOG_TAG]);
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "import: invalidarea cache-ului a eșuat",
      );
    }
    if (imageTasks > 0) await this.enqueueImages(record.id);
    return report;
  }

  /** Salvează sarcinile de imagini ale rândurilor aplicate; la reluarea unui import căzut nu le dublează. */
  private async createImageTasks(
    importId: string,
    plan: ImportPlan,
    finalRows: readonly PlannedRow[],
  ): Promise<number> {
    const tasks = plan.woo?.images.tasks ?? [];
    if (tasks.length === 0) return 0;
    try {
      const existing = await this.deps.store.images.progress([importId]);
      if (existing.has(importId)) return 0;
      const failedRows = new Set(finalRows.filter((r) => r.outcome === "error").map((r) => r.row));
      const productBySku = await this.deps.store.woo.findProductIdsBySku([
        ...new Set(tasks.map((task) => task.sku)),
      ]);
      const rows = [];
      for (const task of tasks) {
        const productId = productBySku.get(task.sku.toLowerCase());
        if (!productId || failedRows.has(task.row)) continue;
        rows.push({
          productId,
          row: task.row,
          sku: task.sku,
          position: task.position,
          sourceUrl: task.url,
          sourceHash: task.sourceHash,
          host: task.host,
        });
      }
      return await this.deps.store.images.insertTasks(importId, rows);
    } catch (error) {
      this.deps.logger.error(
        { reason: error instanceof Error ? error.name : "necunoscut" },
        "import: sarcinile de imagini nu s-au putut salva",
      );
      return 0;
    }
  }

  private async enqueueImages(importId: string): Promise<void> {
    if (!this.deps.imageQueue) return;
    try {
      await this.deps.imageQueue.enqueue(importId);
    } catch (error) {
      // imaginile rămân în așteptare și pot fi reluate din pagina importului
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "import: coada de imagini nu e disponibilă",
      );
    }
  }

  /** Reia descărcarea imaginilor (cele rămase în așteptare și cele eșuate). Doar utilizatorul care a pornit importul. */
  async retryImages(subject: PermissionSubject | null, importId: string): Promise<void> {
    assertCan(subject, "products.write");
    assertCan(subject, "media.write");
    const record = await this.deps.store.get(importId);
    if (!record || record.status !== "completed") {
      throw new ImportError("IMPORT_NOT_FOUND", "Importul nu există sau nu s-a terminat încă");
    }
    if (record.createdById !== subject.userId) {
      throw new ImportError(
        "IMPORT_IMAGES_OWNER",
        "Doar utilizatorul care a pornit importul poate relua imaginile",
      );
    }
    const reset = await this.deps.store.images.resetFailed(importId);
    const progress = (await this.deps.store.images.progress([importId])).get(importId);
    if (!progress || progress.pending === 0) {
      throw new ImportError("IMPORT_NOTHING_TO_APPLY", "Nu există imagini de reluat");
    }
    if (!this.deps.imageQueue) {
      throw new ImportError(
        "IMPORT_QUEUE_UNAVAILABLE",
        "Coada de joburi nu e disponibilă momentan; încearcă din nou",
      );
    }
    try {
      await this.deps.imageQueue.enqueue(importId);
    } catch {
      throw new ImportError(
        "IMPORT_QUEUE_UNAVAILABLE",
        "Coada de joburi nu e disponibilă momentan; încearcă din nou",
      );
    }
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.import.images.retry",
      entity: "product_import",
      entityId: importId,
      after: { pending: progress.pending, retriedFailed: reset },
    });
  }

  /** Imaginile eșuate ale unui import aplicat, cu motivul în română (fără adrese sau detalii interne). */
  async imageFailures(
    subject: PermissionSubject | null,
    importId: string,
  ): Promise<{ row: number; sku: string; host: string; message: string }[]> {
    assertCan(subject, "products.write");
    const found = await this.deps.store.getApplied(importId);
    if (!found) throw new ImportError("IMPORT_NOT_FOUND", "Importul nu există în istoric");
    const failures: ImageFailure[] = await this.deps.store.images.failures(importId, 2000);
    return failures.map((f) => ({
      row: f.row,
      sku: f.sku,
      host: f.host,
      message: imageFailureMessage(f.reason),
    }));
  }

  private wooApplier(): WooApplier {
    const woo = this.deps.woo;
    if (!woo)
      throw new ImportError(
        "IMPORT_PROFILE_UNAVAILABLE",
        "Profilul WooCommerce nu este disponibil",
      );
    return new WooApplier({
      products: this.deps.products,
      assignments: this.deps.assignments,
      categories: woo.categories,
      brands: woo.brands,
      attributeDefs: woo.attributeDefs,
      attributeValues: woo.attributeValues,
      relations: woo.relations,
      store: this.deps.store,
      logger: this.deps.logger,
    });
  }

  /** Un rând: o eroare îl marchează „eroare” cu motivul, fără să oprească importul. */
  private async applyRow(subject: PermissionSubject, row: PlannedRow): Promise<PlannedRow> {
    const op = row.op;
    if (!op) return row;
    try {
      if (op.kind === "create") {
        const input = op.input as { status?: string } & Record<string, unknown>;
        const wanted = input.status;
        // produsul se creează ciornă; o stare dată se aplică după, ca regulile de activare să ruleze
        const created = await this.deps.products.create(subject, { ...input, status: "draft" });
        if (wanted && wanted !== "draft") {
          await this.deps.products.update(subject, created.product.id, { status: wanted });
        }
        return row;
      }
      // operațiile profilului WooCommerce se aplică în `WooApplier`
      if (op.kind !== "update") return row;
      if (op.variantPatch)
        await this.deps.products.updateVariant(subject, op.variantId, op.variantPatch);
      if (op.productPatch) await this.deps.products.update(subject, op.productId, op.productPatch);
      if (op.categoryIds) {
        await this.deps.assignments.setCategories(subject, op.productId, {
          categoryIds: op.categoryIds,
        });
      }
      return row;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // mesajele de domeniu sunt scrise pentru administrator și nu conțin valori sensibile
      const message =
        error instanceof DomainError || typeof code === "string"
          ? (error as Error).message
          : "Rândul nu a putut fi aplicat";
      if (!(error instanceof DomainError) && typeof code !== "string") {
        this.deps.logger.error(
          { row: row.row },
          "import: rând neaplicat din cauza unei erori neașteptate",
        );
      }
      return {
        ...row,
        outcome: "error",
        op: null,
        messages: [...row.messages, { level: "error", text: `Neaplicat: ${message}` }],
      };
    }
  }

  async status(subject: PermissionSubject | null, importId: string): Promise<ImportStatusView> {
    assertCan(subject, "products.write");
    const record = await this.own(subject, importId);
    const progress = await this.deps.store.images.progress([record.id]);
    return {
      importId: record.id,
      images:
        record.status === "completed"
          ? this.imageView(progress.get(record.id), await this.limits())
          : null,
      status: record.status,
      rowCount: record.rowCount,
      processedRows: record.processedRows,
      summary: record.summary,
      report: record.status === "completed" || record.status === "validated" ? record.report : null,
      errorMessage: record.errorMessage,
    };
  }

  /** Anulează un import care nu rulează: șterge fișierul și rândul. */
  async cancel(subject: PermissionSubject | null, importId: string): Promise<void> {
    assertCan(subject, "products.write");
    const record = await this.own(subject, importId);
    if (record.status === "running" || record.status === "queued") {
      // Un import fără activitate de peste `interruptedAfterMinutes` (starea «întrerupt» din istoric) nu mai are cine să-l
      // termine (jobul a căzut): poate fi oprit. Se marchează eșuat și rămâne în istoric; fișierul se șterge (C-17).
      const limits = await this.limits();
      const idleMs = this.now().getTime() - record.updatedAt.getTime();
      if (idleMs <= limits.interruptedAfterMinutes * 60_000) {
        throw new ImportError("IMPORT_STATE_INVALID", "Importul rulează; așteaptă să se termine");
      }
      // tranziție condiționată: dacă între timp jobul și-a revenit și a avansat, starea s-a schimbat și oprirea se refuză
      if (!(await this.deps.store.transition(record.id, [record.status], "failed"))) {
        throw new ImportError("IMPORT_STATE_INVALID", "Importul rulează; așteaptă să se termine");
      }
      await this.deps.store.update(record.id, {
        errorMessage: "Import întrerupt (jobul nu mai avansa); oprit de utilizator.",
        finishedAt: this.now(),
        storageKey: null,
        expiresAt: new Date(this.now().getTime() + limits.historyRetentionDays * 86_400_000),
      });
      await this.deleteFile(record.storageKey);
      return;
    }
    await this.deleteFile(record.storageKey);
    await this.deps.store.delete(record.id);
  }

  /**
   * Rândurile raportului pentru descărcare (antetul primul): cele cu eroare, avertisment sau ignorate,
   * fără conținutul câmpurilor. CSV-ul îl scrie funcția comună (`csvResponse`), nu serviciul.
   */
  async reportRows(
    subject: PermissionSubject | null,
    importId: string,
  ): Promise<{ rows: string[][]; fileName: string }> {
    assertCan(subject, "products.write");
    // raportul unui import APLICAT e în istoric: îl poate descărca oricine are products.write; al unui import
    // doar verificat rămâne al utilizatorului care l-a încărcat
    const found = await this.deps.store.get(importId);
    const applied =
      found !== null && (APPLIED_STATUSES as readonly string[]).includes(found.status);
    if (!found || (!applied && found.createdById !== subject.userId)) {
      throw new ImportError("IMPORT_NOT_FOUND", "Importul nu există sau a expirat");
    }
    if (applied && found.status !== "completed") {
      throw new ImportError("IMPORT_STATE_INVALID", "Importul nu are încă un raport final");
    }
    const report = found.report;
    if (!report) {
      throw new ImportError(
        applied ? "IMPORT_REPORT_PURGED" : "IMPORT_STATE_INVALID",
        applied
          ? "Raportul detaliat a fost șters după perioada de păstrare; au rămas doar contoarele"
          : "Importul nu are încă un raport",
      );
    }
    const rows: string[][] = [["Rând", "SKU", "Rezultat", "Motiv", "Câmpuri schimbate"]];
    for (const warning of report.fileWarnings) rows.push(["", "", "avertisment", warning, ""]);
    for (const entry of report.entries) {
      if (entry.outcome === "new" || entry.outcome === "updated") {
        if (entry.messages.length === 0) continue;
      }
      rows.push([
        String(entry.row),
        entry.sku,
        OUTCOME_LABEL[entry.outcome],
        entry.messages.join(" · "),
        entry.changed.join(", "),
      ]);
    }
    const failures = applied
      ? await this.deps.store.images.failures(importId, REPORT_ENTRY_LIMIT)
      : [];
    for (const failure of failures) {
      rows.push([
        String(failure.row),
        failure.sku,
        "imagine eșuată",
        `${failure.host}: ${imageFailureMessage(failure.reason)}`,
        "",
      ]);
    }
    if (report.truncated) {
      rows.push([
        "",
        "",
        "avertisment",
        `Raportul a fost tăiat la ${REPORT_ENTRY_LIMIT} de rânduri`,
        "",
      ]);
    }
    return { rows, fileName: "raport-import-produse.csv" };
  }
}
