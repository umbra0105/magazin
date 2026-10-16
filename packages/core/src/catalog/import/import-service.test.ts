import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditRow, type AuditStore } from "../../audit/audit-service";
import type { PermissionSubject } from "../../rbac/can";
import { DEFAULT_ROLES } from "../../rbac/catalog";
import { CatalogError } from "../catalog-support";
import {
  ProductImportService,
  buildReport,
  type ImportJobQueue,
  type ImportSettings,
} from "./import-service";
import {
  REPORT_ENTRY_LIMIT,
  type ImportPatch,
  type ImportRecord,
  type ImportStatus,
  type NewImport,
  type ProductImportStore,
} from "./import-store";
import {
  buildBrandIndex,
  buildCategoryIndex,
  type ImportPlan,
  type ImportSnapshot,
} from "./import-plan";
import { encodeWindows1250 } from "../../../test/windows-1250";
import { DEFAULT_IMPORT_LIMITS } from "./import-file";
import { buildTemplate } from "./import-template";

function subjectFor(roleKey: string, userId = `u-${roleKey}`): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId,
    email: `${userId}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

const NOW = new Date("2026-10-17T09:00:00Z");
const settings: ImportSettings = {
  ...DEFAULT_IMPORT_LIMITS,
  maxUploadBytes: 10_000_000,
  syncMaxRows: 100,
  retentionHours: 24,
};

class MemoryStore implements ProductImportStore {
  records = new Map<string, ImportRecord>();
  deleted: string[] = [];
  snapshot: ImportSnapshot = {
    variantsBySku: new Map(),
    slugOwners: new Map(),
    categoryIndex: buildCategoryIndex([]),
    brandIndex: buildBrandIndex([]),
  };
  private n = 0;
  /** Profilul WooCommerce nu e acoperit de aceste teste (are testele lui); magazinul de test nu-l folosește. */
  woo = {
    listAttributes: async () => [],
  } as unknown as ProductImportStore["woo"];
  async loadWooSnapshot(): Promise<never> {
    throw new Error("profilul WooCommerce nu e folosit în aceste teste");
  }

  async create(data: NewImport) {
    const record: ImportRecord = {
      id: `imp-${++this.n}`,
      status: "uploaded",
      mapping: null,
      planHash: null,
      processedRows: 0,
      summary: null,
      report: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: NOW,
      ...data,
    };
    this.records.set(record.id, record);
    return record;
  }
  async get(id: string) {
    return this.records.get(id) ?? null;
  }
  async update(id: string, patch: ImportPatch) {
    const next = { ...(this.records.get(id) as ImportRecord), ...patch };
    this.records.set(id, next);
    return next;
  }
  async transition(id: string, from: readonly ImportStatus[], to: ImportStatus) {
    const record = this.records.get(id);
    if (!record || !from.includes(record.status)) return false;
    record.status = to;
    return true;
  }
  async delete(id: string) {
    this.records.delete(id);
    this.deleted.push(id);
  }
  async findExpired(now: Date) {
    return [...this.records.values()]
      .filter((r) => r.expiresAt < now && r.status !== "running" && r.status !== "queued")
      .map((r) => ({ id: r.id, storageKey: r.storageKey }));
  }
  async loadSnapshot() {
    return this.snapshot;
  }
}

function setup(options: { queue?: ImportJobQueue; syncMaxRows?: number } = {}) {
  const store = new MemoryStore();
  const files = new Map<string, Buffer>();
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: NOW });
    },
    async list() {
      return auditRows;
    },
  };
  const creates: unknown[] = [];
  const products = {
    create: vi.fn(async (_s: PermissionSubject | null, input: unknown) => {
      creates.push(input);
      const title = (input as { title: string }).title;
      if (title.includes("EȘUEAZĂ"))
        throw new CatalogError("CATALOG_SLUG_CONFLICT", "Adresa e luată");
      if (title.includes("BUG")) throw new Error("conexiune pierdută la 10.0.0.5");
      return { product: { id: `p-${creates.length}` }, variants: [] };
    }),
    update: vi.fn(async () => ({})),
    updateVariant: vi.fn(async () => ({})),
  };
  const assignments = { setCategories: vi.fn(async () => []) };
  const warn = vi.fn();
  const error = vi.fn();
  const service = new ProductImportService({
    store,
    storage: {
      async put(key: string, body: Buffer) {
        files.set(key, body);
        return { key, size: body.length, contentType: "" };
      },
      async get(key: string) {
        const body = files.get(key);
        if (!body) throw new Error("lipsă");
        return {
          stream: Readable.from([body]),
          object: { key, size: body.length, contentType: "" },
        };
      },
      async delete(key: string) {
        files.delete(key);
      },
    } as never,
    audit: new AuditService(auditStore),
    products: products as never,
    assignments: assignments as never,
    getSettings: async () => ({
      ...settings,
      syncMaxRows: options.syncMaxRows ?? settings.syncMaxRows,
    }),
    loadSubject: async (userId) => subjectFor("manager", userId),
    ...(options.queue && { queue: options.queue }),
    logger: { warn, error },
    now: () => NOW,
  });
  return { service, store, files, auditRows, products, assignments, creates, warn, error };
}

const csv = (lines: string[]) => ({
  bytes: new TextEncoder().encode(lines.join("\n") + "\n"),
  fileName: "import.csv",
});
const manager = subjectFor("manager");
const COLUMNS = ["sku", "title", "price"] as const;

async function validated(ctx: ReturnType<typeof setup>, rows: string[], subject = manager) {
  const analysis = await ctx.service.register(subject, csv(["SKU;Titlu;Preț", ...rows]));
  const validation = await ctx.service.validate(subject, {
    importId: analysis.importId,
    columns: [...COLUMNS],
  });
  return { analysis, validation };
}

describe("aplicarea rând cu rând", () => {
  it("o eroare pe un rând nu oprește restul: rândul e marcat «eroare» cu motiv, restul se aplică", async () => {
    const ctx = setup();
    const { analysis, validation } = await validated(ctx, [
      "A1;Bun unu;10",
      "A2;EȘUEAZĂ;10",
      "A3;BUG;10",
      "A4;Bun doi;10",
    ]);
    const result = await ctx.service.apply(manager, {
      importId: analysis.importId,
      confirm: true,
      expectedPlanHash: validation.planHash,
    });
    if (result.mode !== "sync") throw new Error("așteptam sincron");
    expect(result.report.counts).toMatchObject({ new: 2, errors: 2 });
    const byRow = new Map(result.report.entries.map((e) => [e.sku, e]));
    expect(byRow.get("A2")?.messages[0]).toBe("Neaplicat: Adresa e luată");
    // o eroare neașteptată nu scurge detalii tehnice (adrese, conexiuni) în raport
    expect(byRow.get("A3")?.messages[0]).toBe("Neaplicat: Rândul nu a putut fi aplicat");
    expect(JSON.stringify(result.report)).not.toContain("10.0.0.5");
    expect(ctx.products.create).toHaveBeenCalledTimes(4);
    expect(ctx.error).toHaveBeenCalledTimes(1);
  });

  it("un produs nou cu stare dată se creează ciornă, apoi starea se aplică (regulile de activare rulează)", async () => {
    const ctx = setup();
    const analysis = await ctx.service.register(
      manager,
      csv(["SKU;Titlu;Preț;Stare", "A1;Bun;10;Activ"]),
    );
    const validation = await ctx.service.validate(manager, {
      importId: analysis.importId,
      columns: ["sku", "title", "price", "status"],
    });
    await ctx.service.apply(manager, {
      importId: analysis.importId,
      confirm: true,
      expectedPlanHash: validation.planHash,
    });
    expect(ctx.creates[0]).toMatchObject({ status: "draft" });
    expect(ctx.products.update).toHaveBeenCalledWith(manager, "p-1", { status: "active" });
  });

  it("progresul se scrie din 10 în 10 rânduri; la final: completat, fișier șters, un singur eveniment de audit", async () => {
    const ctx = setup();
    const rows = Array.from({ length: 25 }, (_, i) => `S${i};Produs ${i};10`);
    const { analysis, validation } = await validated(ctx, rows);
    const updates: number[] = [];
    const original = ctx.store.update.bind(ctx.store);
    ctx.store.update = async (id, patch) => {
      if (patch.processedRows !== undefined) updates.push(patch.processedRows);
      return original(id, patch);
    };
    await ctx.service.apply(manager, {
      importId: analysis.importId,
      confirm: true,
      expectedPlanHash: validation.planHash,
    });
    expect(updates).toEqual([0, 10, 20, 25]);
    const record = ctx.store.records.get(analysis.importId) as ImportRecord;
    expect(record).toMatchObject({ status: "completed", storageKey: null });
    expect(ctx.files.size).toBe(0);
    expect(ctx.auditRows).toHaveLength(1);
    expect(ctx.auditRows[0]).toMatchObject({
      action: "product.import",
      entity: "product_import",
      entityId: analysis.importId,
      after: { rows: 25, created: 25, errors: 0, updated: 0 },
    });
    // retenția: raportul rămâne 24 h după final
    expect(record.expiresAt.getTime()).toBe(NOW.getTime() + 24 * 3_600_000);
  });
});

describe("CSV salvat din Excel (separator «,», Windows-1250)", () => {
  it("se încarcă, se mapează automat, se verifică și se aplică; diacriticele ajung corecte (ș, ț cu virgulă)", async () => {
    const ctx = setup();
    const ti = String.fromCharCode(0x21b);
    const si = String.fromCharCode(0x219);
    const excel = [
      '"SKU","Titlu","Preț (lei, cu TVA)"',
      `"A1","Pomp${String.fromCharCode(0x103)} de circula${ti}ie ${si}i filtru","1299,50"`,
    ].join("\r\n");
    const analysis = await ctx.service.register(manager, {
      bytes: encodeWindows1250(excel),
      fileName: "din-excel.csv",
    });
    expect(analysis).toMatchObject({
      delimiter: ",",
      delimiterSource: "detected",
      encoding: "windows-1250",
    });
    expect(analysis.warnings[0]).toMatch(/Windows-1250/);
    expect(analysis.headers[2]).toBe("Preț (lei, cu TVA)");
    expect(analysis.columns.map((c) => c.field)).toEqual(["sku", "title", "price"]);

    const validation = await ctx.service.validate(manager, {
      importId: analysis.importId,
      columns: analysis.columns.map((c) => c.field),
    });
    expect(validation.report.counts).toMatchObject({ new: 1, errors: 0 });
    // fișierul stocat rămâne în octeții lui originali; delimitatorul detectat se salvează pentru aplicare
    expect(ctx.store.records.get(analysis.importId)?.delimiter).toBe(",");
    await ctx.service.apply(manager, {
      importId: analysis.importId,
      confirm: true,
      expectedPlanHash: validation.planHash,
    });
    expect(ctx.creates[0]).toMatchObject({
      title: `Pompă de circula${ti}ie ${si}i filtru`,
      variants: [{ sku: "A1", price: 129_950 }],
    });
  });

  it("șablonul CSV al aplicației (cu linia sep=) se încarcă înapoi: delimitatorul vine din fișier", async () => {
    const ctx = setup();
    const analysis = await ctx.service.register(manager, {
      bytes: await buildTemplate("csv"),
      fileName: "sablon.csv",
    });
    expect(analysis).toMatchObject({ delimiter: ";", delimiterSource: "sep-line", warnings: [] });
    expect(analysis.headers[0]).toBe("SKU");
    expect(analysis.rowCount).toBe(2);
  });
});

describe("pașii și protecțiile", () => {
  it("aplicarea cere confirmare explicită și starea «verificat»", async () => {
    const ctx = setup();
    const analysis = await ctx.service.register(manager, csv(["SKU;Titlu;Preț", "A1;Bun;10"]));
    await expect(
      ctx.service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_STATE_INVALID" });
    await expect(
      ctx.service.apply(manager, { importId: analysis.importId, expectedPlanHash: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("fișierul stocat modificat după încărcare e refuzat (hash)", async () => {
    const ctx = setup();
    const analysis = await ctx.service.register(manager, csv(["SKU;Titlu;Preț", "A1;Bun;10"]));
    const [key] = [...ctx.files.keys()];
    ctx.files.set(key as string, Buffer.from("SKU;Titlu;Preț\nA1;Altceva;99\n"));
    await expect(
      ctx.service.validate(manager, { importId: analysis.importId, columns: [...COLUMNS] }),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_CHANGED" });
  });

  it("dacă coada nu e disponibilă, importul revine la «verificat» și nu rămâne blocat", async () => {
    const queue: ImportJobQueue = {
      async enqueue() {
        throw new Error("Redis jos");
      },
    };
    const ctx = setup({ queue, syncMaxRows: 1 });
    const { analysis, validation } = await validated(ctx, ["A1;Bun;10", "A2;Bun;10"]);
    await expect(
      ctx.service.apply(manager, {
        importId: analysis.importId,
        confirm: true,
        expectedPlanHash: validation.planHash,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_QUEUE_UNAVAILABLE" });
    expect(ctx.store.records.get(analysis.importId)?.status).toBe("validated");
    expect(ctx.products.create).not.toHaveBeenCalled();
  });

  it("al doilea apel pe un import deja pornit e refuzat (fără aplicare dublă)", async () => {
    const ctx = setup();
    const { analysis, validation } = await validated(ctx, ["A1;Bun;10"]);
    const request = {
      importId: analysis.importId,
      confirm: true as const,
      expectedPlanHash: validation.planHash,
    };
    await ctx.service.apply(manager, request);
    await expect(ctx.service.apply(manager, request)).rejects.toMatchObject({
      code: "IMPORT_STATE_INVALID",
    });
    expect(ctx.products.create).toHaveBeenCalledTimes(1);
  });

  it("anularea șterge fișierul și rândul; un import care rulează nu se anulează", async () => {
    const ctx = setup();
    const a = await ctx.service.register(manager, csv(["SKU;Titlu;Preț", "A1;Bun;10"]));
    await ctx.service.cancel(manager, a.importId);
    expect(ctx.files.size).toBe(0);
    expect(ctx.store.records.has(a.importId)).toBe(false);

    const b = await ctx.service.register(manager, csv(["SKU;Titlu;Preț", "B1;Bun;10"]));
    ctx.store.records.get(b.importId)!.status = "running";
    await expect(ctx.service.cancel(manager, b.importId)).rejects.toMatchObject({
      code: "IMPORT_STATE_INVALID",
    });
  });

  it("fișierul încărcat peste limite nu se stochează", async () => {
    const ctx = setup();
    await expect(
      ctx.service.register(manager, {
        bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1]),
        fileName: "v.xls",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_UNSUPPORTED" });
    expect(ctx.files.size).toBe(0);
    expect(ctx.store.records.size).toBe(0);
  });

  it("Editorul, Depozitul și anonimul sunt refuzați la fiecare pas", async () => {
    const ctx = setup();
    for (const subject of [subjectFor("editor"), subjectFor("warehouse"), null]) {
      await expect(ctx.service.register(subject, csv(["SKU;Titlu", "A;b"]))).rejects.toBeDefined();
      await expect(ctx.service.analyze(subject, "x")).rejects.toBeDefined();
      await expect(ctx.service.validate(subject, {})).rejects.toBeDefined();
      await expect(ctx.service.apply(subject, {})).rejects.toBeDefined();
      await expect(ctx.service.status(subject, "x")).rejects.toBeDefined();
      await expect(ctx.service.cancel(subject, "x")).rejects.toBeDefined();
      await expect(ctx.service.reportRows(subject, "x")).rejects.toBeDefined();
    }
    expect(ctx.files.size).toBe(0);
  });
});

describe("buildReport", () => {
  const row = (n: number, outcome: "new" | "error" | "unchanged") => ({
    row: n,
    sku: `S${n}`,
    outcome,
    messages: outcome === "error" ? [{ level: "error" as const, text: "greșit" }] : [],
    changed: [],
    op: null,
  });

  it("nu include rândurile neschimbate; erorile apar primele; se taie la limită cu marcaj", () => {
    const rows = [
      ...Array.from({ length: REPORT_ENTRY_LIMIT + 10 }, (_, i) => row(i + 2, "new")),
      row(5000, "error"),
      row(5001, "unchanged"),
    ];
    const plan = {
      rows,
      counts: { new: 0, updated: 0, unchanged: 1, skipped: 0, errors: 1, warnings: 0 },
      fileWarnings: ["avertisment"],
      fingerprint: "x",
    } as ImportPlan;
    const report = buildReport(plan);
    expect(report.entries).toHaveLength(REPORT_ENTRY_LIMIT);
    expect(report.entries[0]).toMatchObject({ row: 5000, outcome: "error" });
    expect(report.entries.some((e) => e.outcome === "unchanged")).toBe(false);
    expect(report.truncated).toBe(true);
    expect(report.fileWarnings).toEqual(["avertisment"]);
  });
});
