import { DomainError } from "@ecom/shared";
import type { AuditService } from "../../audit/audit-service";
import { assertCan, type PermissionSubject } from "../../rbac/can";
import { readNirFile } from "./nir-file";
import { NirFileError, parseNirTable } from "./nir-parse";
import { planNirImport, type NirReport } from "./nir-plan";
import { nirReportRows, nirTemplateRows } from "./nir-report";
import type { NirImportRecord, NirStore } from "./nir-store";

/**
 * Importul prețurilor de achiziție (NIR) din exportul SmartBill «mișcări produse» (Faza 15, docs/09 §4): previzualizare fără scriere
 * (dry-run), confirmare, procesare în coadă, raport. Permisiuni, verificate pe server la fiecare pas:
 *  - încărcarea și confirmarea cer `products.cost.import` ȘI `products.cost.view` (altfel ar fi un oracol: scrii costuri fără să le vezi);
 *  - raportul, lista importurilor și șablonul cer `products.cost.view`.
 * Auditul (`product.cost.import`) păstrează doar identificatori și numere: niciun cost, niciun cod, nicio dată personală.
 */

export class NirImportError extends DomainError {}

/** Cât stă valabilă o previzualizare. */
export const NIR_PREVIEW_HOURS = 24;
/** Câte variante se actualizează într-o tranzacție. */
export const NIR_BATCH_SIZE = 200;
/** Câte importuri recente apar în listă. */
export const NIR_LIST_LIMIT = 20;

export interface NirJobQueue {
  enqueue(importId: string): Promise<void>;
}

export interface NirImportDeps {
  store: NirStore;
  audit: AuditService;
  /** Fără coadă, `confirm` rulează importul pe loc (testele și dezvoltarea fără worker). */
  queue?: NirJobQueue;
  now?: () => Date;
  logger?: { error(obj: unknown, message: string): void };
}

export type NirImportView = Omit<NirImportRecord, "plan">;

const NOT_FOUND = () => new NirImportError("NIR_IMPORT_NOT_FOUND", "Importul nu există.");

function assertImportAndView(
  subject: PermissionSubject | null,
): asserts subject is PermissionSubject {
  assertCan(subject, "products.cost.import");
  assertCan(subject, "products.cost.view");
}

export class NirImportService {
  private readonly now: () => Date;

  constructor(private readonly deps: NirImportDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Citește fișierul și întoarce previzualizarea (nu scrie nimic în catalog). */
  async preview(
    subject: PermissionSubject | null,
    file: { name: string; bytes: Uint8Array },
  ): Promise<NirImportView> {
    assertImportAndView(subject);
    const read = await readNirFile(file.bytes);
    const table = parseNirTable(read.grid);
    const catalog = await this.deps.store.loadCatalog(
      table.rows.flatMap((row) => (row.code ? [row.code] : [])),
    );
    const now = this.now();
    const plan = planNirImport({ rows: table.rows, counters: table.counters, catalog, now });
    const fileName = file.name.trim().slice(0, 200) || "fisier";
    const created = await this.deps.store.create({
      createdById: subject.userId,
      fileName,
      format: read.format,
      sizeBytes: read.byteLength,
      fileHash: read.fileHash,
      rowCount: table.rows.length,
      plan: plan.items,
      report: plan.report,
      expiresAt: new Date(now.getTime() + NIR_PREVIEW_HOURS * 3_600_000),
    });
    return toView(created);
  }

  /** Confirmă o previzualizare: importul trece în coadă (sau rulează pe loc fără coadă). */
  async confirm(subject: PermissionSubject | null, id: string): Promise<NirImportView> {
    assertImportAndView(subject);
    const existing = await this.deps.store.get(id);
    if (!existing) throw NOT_FOUND();
    const now = this.now();
    if (existing.status === "previewed" && existing.expiresAt.getTime() <= now.getTime()) {
      throw new NirImportError(
        "NIR_IMPORT_EXPIRED",
        "Previzualizarea a expirat. Încarcă din nou fișierul.",
      );
    }
    if (!(await this.deps.store.queue(id, now))) {
      throw new NirImportError(
        "NIR_IMPORT_STATE",
        "Importul a fost deja confirmat sau nu mai poate fi confirmat.",
      );
    }
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "product.cost.import",
      entity: "nir_import",
      entityId: id,
      after: { stage: "confirmed", rows: existing.rowCount, items: existing.itemCount },
    });
    if (this.deps.queue) {
      try {
        await this.deps.queue.enqueue(id);
      } catch {
        await this.deps.store.finish(id, {
          status: "failed",
          message: "Importul nu a putut fi pus în coadă. Încarcă din nou fișierul.",
          now: this.now(),
        });
        throw new NirImportError(
          "NIR_IMPORT_QUEUE_UNAVAILABLE",
          "Coada de fundal nu răspunde. Importul nu a început; încarcă din nou fișierul.",
        );
      }
    } else {
      await this.runQueued(id);
    }
    const after = await this.deps.store.get(id);
    return toView(after ?? existing);
  }

  async get(subject: PermissionSubject | null, id: string): Promise<NirImportView> {
    assertCan(subject, "products.cost.view");
    const found = await this.deps.store.get(id);
    if (!found) throw NOT_FOUND();
    return toView(found);
  }

  async list(subject: PermissionSubject | null): Promise<NirImportView[]> {
    assertCan(subject, "products.cost.view");
    return this.deps.store.list(NIR_LIST_LIMIT);
  }

  /** Rândurile raportului pentru `csvResponse` (cere `products.cost.view`). */
  async reportRows(subject: PermissionSubject | null, id: string): Promise<string[][]> {
    return nirReportRows((await this.get(subject, id)).report);
  }

  /** Rândurile șablonului pentru `csvResponse` (cere `products.cost.view`). */
  templateRows(subject: PermissionSubject | null): string[][] {
    assertCan(subject, "products.cost.view");
    return nirTemplateRows(this.now());
  }

  /**
   * Rulează un import confirmat (jobul din coadă). Idempotent: un import care nu mai e «în coadă» nu se reia. Nu aruncă pentru erori
   * de aplicare: importul rămâne «eșuat», cu un mesaj fără valori.
   */
  async runQueued(importId: string): Promise<void> {
    const now = this.now();
    if (!(await this.deps.store.claim(importId, now))) return;
    const found = await this.deps.store.get(importId);
    if (!found) return;
    try {
      const updatedIds = new Set<string>();
      let processed = 0;
      for (let i = 0; i < found.plan.length; i += NIR_BATCH_SIZE) {
        const chunk = found.plan.slice(i, i + NIR_BATCH_SIZE);
        const outcome = await this.deps.store.applyBatch(importId, chunk);
        for (const variantId of outcome.updatedVariantIds) updatedIds.add(variantId);
        processed += chunk.length;
        await this.deps.store.progress(importId, processed);
      }
      const report = finalReport(found, updatedIds);
      await this.deps.store.finish(importId, {
        status: "completed",
        report,
        processedItems: found.plan.length,
        now: this.now(),
      });
      await this.deps.audit.record({
        actorId: found.createdById,
        actorLabel: "worker",
        action: "product.cost.import",
        entity: "nir_import",
        entityId: importId,
        after: {
          stage: "completed",
          updated: report.counters.updated,
          unchanged: report.counters.unchanged,
          unknown: report.counters.unknownCodes,
          invalid: report.counters.invalid,
        },
      });
    } catch (error) {
      this.deps.logger?.error(
        { importId, reason: error instanceof Error ? error.name : "eroare" },
        "import NIR: aplicarea a eșuat",
      );
      await this.deps.store.finish(importId, {
        status: "failed",
        message:
          "Importul s-a oprit din cauza unei erori. Ce era deja aplicat rămâne; încarcă din nou fișierul ca să continui (rândurile aplicate apar atunci ca «neschimbate»).",
        now: this.now(),
      });
    }
  }
}

/** Importul fără plan (planul poartă costurile fiecărei variante și rămâne în nucleu). */
function toView(record: NirImportRecord): NirImportView {
  const view: Partial<NirImportRecord> = { ...record };
  delete view.plan;
  return view as NirImportView;
}

/** Raportul final: ce s-a actualizat cu adevărat (sub blocare) și ce a rămas neschimbat între timp. */
function finalReport(record: NirImportRecord, updatedIds: ReadonlySet<string>): NirReport {
  const planned = new Map(record.plan.map((item) => [item.row, item]));
  const updated = record.report.updated.filter((row) => {
    const item = planned.get(row.row);
    return item !== undefined && updatedIds.has(item.variantId);
  });
  const movedToUnchanged = record.report.updated.filter((row) => {
    const item = planned.get(row.row);
    return item === undefined || !updatedIds.has(item.variantId);
  });
  const unchanged = [...record.report.unchanged, ...movedToUnchanged].sort((a, b) => a.row - b.row);
  return {
    ...record.report,
    updated,
    unchanged,
    counters: { ...record.report.counters, updated: updated.length, unchanged: unchanged.length },
  };
}

export { NirFileError };
