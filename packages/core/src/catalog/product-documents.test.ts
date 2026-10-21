import type { Readable } from "node:stream";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type {
  ListOptions,
  ListResult,
  PutOptions,
  SignedUrlOptions,
  StorageDriver,
  StoredObject,
} from "@ecom/integrations";
import { StorageError } from "@ecom/integrations";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import {
  DOCUMENT_KEY_PREFIX,
  ProductDocumentsService,
  findPdfActiveContent,
  isPdf,
  sweepOrphanDocuments,
  type DocumentRecord,
  type ProductDocumentStore,
} from "./product-documents";

function roleSubject(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

const pdf = (extra = ""): Buffer =>
  Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\ntrailer\n%%EOF\n`,
    "latin1",
  );

async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

class MemoryStorage implements StorageDriver {
  readonly kind = "local" as const;
  objects = new Map<string, { body: Buffer; options: PutOptions; at: Date }>();
  failPut = false;
  failDelete = false;
  deleted: string[] = [];
  now = () => new Date();

  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    if (this.failPut) throw new StorageError("STORAGE_FAILED", "căzut");
    this.objects.set(key, { body, options, at: this.now() });
    return { key, size: body.length, contentType: options.contentType };
  }
  async get(): Promise<{ stream: Readable; object: StoredObject }> {
    throw new Error("nefolosit");
  }
  async stat(): Promise<StoredObject | null> {
    return null;
  }
  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new StorageError("STORAGE_FAILED", "căzut");
    this.deleted.push(key);
    this.objects.delete(key);
  }
  publicUrl(): string {
    throw new Error("nefolosit");
  }
  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return `https://magazin.test/storage/signed/${key}?exp=${options.expiresInSeconds}&dl=${encodeURIComponent(options.downloadFilename ?? "")}`;
  }
  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.body.length, lastModified: o.at }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const limit = options.limit ?? 1000;
    return { objects: objects.slice(0, limit), truncated: objects.length > limit };
  }
}

type Row = DocumentRecord & { storageKey: string };

/** Rândul fără cheia de stocare (cum îl întoarce serviciul). */
function publicRecord(row: Row): DocumentRecord {
  const copy: Partial<Row> = { ...row };
  delete copy.storageKey;
  return copy as DocumentRecord;
}

class MemoryStore implements ProductDocumentStore {
  products = new Map<string, { id: string; slug: string; deletedAt: Date | null }>();
  rows = new Map<string, Row>();
  failCreate = false;
  failReplace = false;
  private n = 0;

  async getProduct(id: string) {
    return this.products.get(id) ?? null;
  }
  async list(productId: string) {
    return [...this.rows.values()]
      .filter((r) => r.productId === productId)
      .sort((a, b) => a.position - b.position)
      .map((row) => publicRecord(row));
  }
  async count(productId: string) {
    return (await this.list(productId)).length;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async create(row: Parameters<ProductDocumentStore["create"]>[0]) {
    if (this.failCreate) throw new Error("baza căzută");
    const id = `d${++this.n}`;
    const record: Row = {
      id,
      productId: row.productId,
      type: row.type,
      title: row.title,
      originalName: row.originalName,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      language: row.language,
      position: this.n,
      showInTab: row.showInTab,
      createdAt: new Date(),
      storageKey: row.storageKey,
    };
    this.rows.set(id, record);
    return publicRecord(record);
  }
  async update(id: string, patch: Parameters<ProductDocumentStore["update"]>[1]) {
    const next = { ...(this.rows.get(id) as Row), ...patch };
    this.rows.set(id, next);
    return publicRecord(next);
  }
  async replaceFile(id: string, file: Parameters<ProductDocumentStore["replaceFile"]>[1]) {
    if (this.failReplace) throw new Error("baza căzută");
    const current = this.rows.get(id) as Row;
    const next = { ...current, ...file };
    this.rows.set(id, next);
    return { record: publicRecord(next), previousKey: current.storageKey };
  }
  async delete(id: string) {
    const row = this.rows.get(id);
    if (!row) return null;
    this.rows.delete(id);
    return { productId: row.productId, storageKey: row.storageKey };
  }
  async reorder(productId: string, orderedIds: readonly string[]) {
    orderedIds.forEach((id, position) => {
      const row = this.rows.get(id);
      if (row && row.productId === productId) row.position = position;
    });
  }
  async listStorageKeys() {
    return [...this.rows.values()].map((r) => r.storageKey);
  }
}

function setup() {
  const store = new MemoryStore();
  store.products.set("p1", { id: "p1", slug: "p-1", deletedAt: null });
  const storage = new MemoryStorage();
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const warn = vi.fn();
  const invalidated: string[][] = [];
  const service = new ProductDocumentsService({
    store,
    storage,
    audit: new AuditService(auditStore),
    getMaxInputPixels: async () => 40_000_000,
    invalidate: (tags) => void invalidated.push([...tags]),
    logger: { warn, error: vi.fn() },
  });
  return { store, storage, service, auditRows, warn, invalidated };
}

const editor = () => roleSubject("editor");
const manager = () => roleSubject("manager");

describe("detecția PDF și a conținutului activ", () => {
  it("un PDF se recunoaște din antet, nu din extensie", () => {
    expect(isPdf(pdf())).toBe(true);
    expect(isPdf(Buffer.from("Acesta e un text, nu un PDF"))).toBe(false);
    expect(isPdf(Buffer.from(" %PDF-1.4"))).toBe(false); // spațiu înainte de antet
  });

  it("găsește JavaScript, JS, Launch, fișiere atașate, RichMedia și XFA", () => {
    for (const [extra, marker] of [
      ["/OpenAction << /S /JavaScript /JS (app.alert(1)) >>", "JavaScript"],
      ["/AA << /O << /S /JS /JS (x) >> >>", "JS"],
      ["/Action << /S /Launch /F (cmd.exe) >>", "Launch"],
      ["/Names << /EmbeddedFiles 5 0 R >>", "EmbeddedFile"],
      ["/Subtype /RichMedia", "RichMedia"],
      ["/AcroForm << /XFA 7 0 R >>", "XFA"],
    ] as const) {
      expect(findPdfActiveContent(pdf(extra)), extra).toContain(marker);
    }
  });

  it("vede și numele ofuscate prin #xx (/J#61vaScript)", () => {
    expect(findPdfActiveContent(pdf("/S /J#61vaScript"))).toContain("JavaScript");
    expect(findPdfActiveContent(pdf("/#4Aava#53cript"))).toContain("JavaScript");
  });

  it("nu dă fals pozitive pe nume asemănătoare sau pe un PDF obișnuit", () => {
    expect(findPdfActiveContent(pdf())).toEqual([]);
    expect(
      findPdfActiveContent(pdf("/OpenAction [ 0 /Fit ] /JSX /Launcher /EmbeddedFilesX")),
    ).toEqual([]);
    expect(findPdfActiveContent(pdf("/Title (Manual JavaScript pentru începători)"))).toEqual([]);
  });
});

describe("încărcarea documentelor", () => {
  it("PDF valid: cheia e generată de server, numele nu intră în cheie, auditul nu are conținutul", async () => {
    const { service, storage, auditRows, invalidated } = setup();
    const record = await service.upload(
      editor(),
      "p1",
      { bytes: pdf(), originalName: "../../Manual pompă ÎNCĂRCARE.pdf" },
      { type: "manual", title: "Manual pompă" },
    );
    expect(record).toMatchObject({
      type: "manual",
      title: "Manual pompă",
      mime: "application/pdf",
      language: "ro",
      showInTab: true,
    });
    expect(record.originalName).toBe("Manual pompă ÎNCĂRCARE.pdf");

    const [key] = [...storage.objects.keys()];
    expect(key).toMatch(/^private\/product-documents\/[0-9a-f-]{36}\.pdf$/);
    expect(key).not.toContain("Manual");
    expect(storage.objects.get(key as string)?.options.contentType).toBe("application/pdf");

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "product.document.upload",
      outcome: "success",
      after: { documentId: record.id, type: "manual", mime: "application/pdf" },
    });
    const dump = JSON.stringify(auditRows);
    expect(dump).not.toContain("Manual");
    expect(dump).not.toContain("%PDF");
    expect(invalidated[0]).toEqual(expect.arrayContaining(["product:p1", "catalog"]));
  });

  it("imagine PNG: acceptată, re-codificată; titlul implicit vine din nume", async () => {
    const { service, storage } = setup();
    const record = await service.upload(
      manager(),
      "p1",
      { bytes: await png(), originalName: "eticheta-energetica.png" },
      { type: "energy_label" },
    );
    expect(record).toMatchObject({ mime: "image/png", title: "eticheta-energetica" });
    expect([...storage.objects.keys()][0]).toMatch(/\.png$/);
  });

  it("un .txt redenumit .pdf, un GIF și un fișier gol se refuză, fără nimic scris", async () => {
    const { service, storage, store } = setup();
    const attempts: [Buffer, string][] = [
      [Buffer.from("Doar text, nu un PDF."), "fals.pdf"],
      [
        Buffer.from(
          "GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04",
          "latin1",
        ),
        "a.png",
      ],
      [Buffer.alloc(0), "gol.pdf"],
    ];
    for (const [bytes, name] of attempts) {
      await expect(
        service.upload(editor(), "p1", { bytes, originalName: name }, { type: "other" }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^DOCUMENT_(TYPE_UNSUPPORTED|EMPTY)$/),
      });
    }
    expect(storage.objects.size).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("PDF cu conținut activ: refuzat cu mesaj și soluție, fără nimic scris", async () => {
    const { service, storage, store } = setup();
    const error = await service
      .upload(
        editor(),
        "p1",
        { bytes: pdf("/OpenAction << /S /JavaScript /JS (x) >>"), originalName: "m.pdf" },
        { type: "manual" },
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "DOCUMENT_ACTIVE_CONTENT" });
    expect((error as Error).message).toContain("Tipărește");
    expect(storage.objects.size).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("dacă rândul nu se poate scrie, fișierul pus în stocare se șterge (fără orfan)", async () => {
    const { service, storage, store } = setup();
    store.failCreate = true;
    await expect(
      service.upload(editor(), "p1", { bytes: pdf(), originalName: "m.pdf" }, { type: "manual" }),
    ).rejects.toThrow("baza căzută");
    expect(storage.objects.size).toBe(0);
    expect(storage.deleted).toHaveLength(1);
  });

  it("stocarea căzută: eroare clară, niciun rând", async () => {
    const { service, storage, store } = setup();
    storage.failPut = true;
    await expect(
      service.upload(editor(), "p1", { bytes: pdf(), originalName: "m.pdf" }, { type: "manual" }),
    ).rejects.toMatchObject({ code: "DOCUMENT_STORAGE_UNAVAILABLE" });
    expect(store.rows.size).toBe(0);
  });

  it("permisiuni: Editorul (conținut) poate; Depozit și Suport nu; audit denied fără conținut", async () => {
    const { service, auditRows, storage } = setup();
    for (const role of ["warehouse", "support"]) {
      await expect(
        service.upload(
          roleSubject(role),
          "p1",
          { bytes: pdf(), originalName: "m.pdf" },
          { type: "manual" },
        ),
      ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    }
    expect(storage.objects.size).toBe(0);
    expect(auditRows.every((r) => r.outcome === "denied")).toBe(true);
    await service.upload(
      editor(),
      "p1",
      { bytes: pdf(), originalName: "m.pdf" },
      { type: "manual" },
    );
  });

  it("metadate invalide: tip necunoscut, limbă greșită; produs șters sau inexistent", async () => {
    const { service, store } = setup();
    const file = { bytes: pdf(), originalName: "m.pdf" };
    await expect(service.upload(editor(), "p1", file, { type: "altceva" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      service.upload(editor(), "p1", file, { type: "manual", language: "romana" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    store.products.set("gone", { id: "gone", slug: "g", deletedAt: new Date() });
    await expect(service.upload(editor(), "gone", file, { type: "manual" })).rejects.toMatchObject({
      code: "CATALOG_PRODUCT_DELETED",
    });
    await expect(service.upload(editor(), "lipsa", file, { type: "manual" })).rejects.toMatchObject(
      {
        code: "CATALOG_PRODUCT_NOT_FOUND",
      },
    );
  });

  it("limita de documente per produs", async () => {
    const { service } = setup();
    for (let i = 0; i < 50; i++) {
      await service.upload(
        editor(),
        "p1",
        { bytes: pdf(), originalName: `m${i}.pdf` },
        { type: "other" },
      );
    }
    await expect(
      service.upload(editor(), "p1", { bytes: pdf(), originalName: "m.pdf" }, { type: "other" }),
    ).rejects.toMatchObject({ code: "DOCUMENT_LIMIT" });
  });
});

describe("ștergere, înlocuire, ordine, descărcare", () => {
  const upload = (s: ReturnType<typeof setup>, name = "m.pdf") =>
    s.service.upload(editor(), "p1", { bytes: pdf(), originalName: name }, { type: "manual" });

  it("ștergerea scoate rândul ȘI fișierul; un eșec la fișier nu anulează ștergerea (orfan raportat)", async () => {
    const s = setup();
    const a = await upload(s, "a.pdf");
    const b = await upload(s, "b.pdf");
    await s.service.remove(editor(), a.id);
    expect(s.store.rows.has(a.id)).toBe(false);
    expect(s.storage.objects.size).toBe(1);

    s.storage.failDelete = true;
    await s.service.remove(editor(), b.id);
    expect(s.store.rows.has(b.id)).toBe(false);
    expect(s.storage.objects.size).toBe(1); // orfan: îl găsește sweep-ul
    expect(s.warn).toHaveBeenCalled();
    expect(s.auditRows.at(-1)).toMatchObject({ action: "product.document.delete" });
  });

  it("înlocuirea: cheie nouă, fișierul vechi șters; dacă rândul eșuează, cel vechi rămâne și cel nou se șterge", async () => {
    const s = setup();
    const doc = await upload(s);
    const oldKey = (s.store.rows.get(doc.id) as Row).storageKey;

    const replaced = await s.service.replace(editor(), "p1", doc.id, {
      bytes: await png(),
      originalName: "nou.png",
    });
    expect(replaced).toMatchObject({ mime: "image/png", originalName: "nou.png" });
    const newKey = (s.store.rows.get(doc.id) as Row).storageKey;
    expect(newKey).not.toBe(oldKey);
    expect(s.storage.objects.has(oldKey)).toBe(false);
    expect(s.storage.objects.has(newKey)).toBe(true);

    s.store.failReplace = true;
    await expect(
      s.service.replace(editor(), "p1", doc.id, { bytes: pdf(), originalName: "x.pdf" }),
    ).rejects.toThrow("baza căzută");
    expect(s.storage.objects.size).toBe(1);
    expect(s.storage.objects.has(newKey)).toBe(true);
  });

  it("înlocuirea cu PDF activ sau tip greșit refuză și păstrează fișierul existent", async () => {
    const s = setup();
    const doc = await upload(s);
    await expect(
      s.service.replace(editor(), "p1", doc.id, {
        bytes: pdf("/Launch"),
        originalName: "x.pdf",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ACTIVE_CONTENT" });
    await expect(
      s.service.replace(editor(), "p1", doc.id, {
        bytes: Buffer.from("text"),
        originalName: "x.pdf",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TYPE_UNSUPPORTED" });
    // alt produs: documentul nu se găsește
    await expect(
      s.service.replace(editor(), "alt-produs", doc.id, { bytes: pdf(), originalName: "x.pdf" }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
    expect(s.storage.objects.size).toBe(1);
  });

  /**
   * Blocul C, C-21: un patch care nu schimba nimic întorcea înregistrarea din `store.get` (care include `storageKey`) direct în
   * răspunsul acțiunii către browser: cheia privată `private/product-documents/<uuid>.pdf`, pe care rândul public nu o are.
   */
  it("un patch fără schimbări nu scurge cheia privată de stocare", async () => {
    const s = setup();
    const a = await upload(s, "a.pdf");
    const unchanged = await s.service.update(editor(), a.id, { title: a.title });
    expect(unchanged).not.toHaveProperty("storageKey");
    expect(JSON.stringify(unchanged)).not.toContain("private/");
    expect(unchanged).toEqual(a);
  });

  it("metadate: titlu/tip/limbă/afișare; neschimbat nu auditează; ordinea cere lista exactă", async () => {
    const s = setup();
    const a = await upload(s, "a.pdf");
    const b = await upload(s, "b.pdf");
    const before = s.auditRows.length;
    await s.service.update(editor(), a.id, { title: a.title });
    expect(s.auditRows.length).toBe(before);

    const updated = await s.service.update(editor(), a.id, {
      title: "Fișă tehnică",
      type: "datasheet",
      language: "en",
      showInTab: false,
    });
    expect(updated).toMatchObject({
      title: "Fișă tehnică",
      type: "datasheet",
      language: "en",
      showInTab: false,
    });

    const ordered = await s.service.reorder(editor(), "p1", [b.id, a.id]);
    expect(ordered.map((d) => d.id)).toEqual([b.id, a.id]);
    await expect(s.service.reorder(editor(), "p1", [a.id])).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });

  it("linkul de descărcare: semnat, scurt, cu numele original; doar pentru produsul documentului", async () => {
    const s = setup();
    const doc = await upload(s, "Manual.pdf");
    const { url } = await s.service.downloadLink(editor(), "p1", doc.id);
    expect(url).toContain("/storage/signed/private/product-documents/");
    expect(url).toContain("exp=120");
    expect(url).toContain(`dl=${encodeURIComponent("Manual.pdf")}`);
    await expect(s.service.downloadLink(editor(), "alt-produs", doc.id)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
    await expect(
      s.service.downloadLink(roleSubject("support"), "p1", doc.id),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});

describe("curățarea orfanilor (strict pe private/product-documents/)", () => {
  const OLD = new Date("2026-10-01T00:00:00Z");
  const NOW = new Date("2026-10-15T12:00:00Z");

  function fixture() {
    const storage = new MemoryStorage();
    const rows = new Set<string>();
    const store = { listStorageKeys: async () => [...rows] };
    const put = (key: string, at: Date) => {
      storage.objects.set(key, {
        body: Buffer.from("x"),
        options: { contentType: "application/pdf" },
        at,
      });
    };
    return { storage, rows, store, put };
  }

  it("un obiect cu rând asociat NU e raportat; unul fără rând și vechi e orfan", async () => {
    const { storage, rows, store, put } = fixture();
    put(`${DOCUMENT_KEY_PREFIX}cu-rand.pdf`, OLD);
    put(`${DOCUMENT_KEY_PREFIX}fara-rand.pdf`, OLD);
    rows.add(`${DOCUMENT_KEY_PREFIX}cu-rand.pdf`);

    const report = await sweepOrphanDocuments({ storage, store, now: () => NOW });
    expect(report.scanned).toBe(2);
    expect(report.orphans.map((o) => o.key)).toEqual([`${DOCUMENT_KEY_PREFIX}fara-rand.pdf`]);
    expect(report.deleted).toEqual([]);
    // doar raport: nimic șters
    expect(storage.objects.size).toBe(2);
  });

  it("cu delete: șterge doar orfanii mai vechi de 1 oră; cele recente rămân", async () => {
    const { storage, store, put } = fixture();
    put(`${DOCUMENT_KEY_PREFIX}vechi.pdf`, OLD);
    put(`${DOCUMENT_KEY_PREFIX}recent.pdf`, new Date(NOW.getTime() - 10 * 60 * 1000));

    const report = await sweepOrphanDocuments({ storage, store, delete: true, now: () => NOW });
    expect(report.deleted).toEqual([`${DOCUMENT_KEY_PREFIX}vechi.pdf`]);
    expect(report.tooRecent).toBe(1);
    expect([...storage.objects.keys()]).toEqual([`${DOCUMENT_KEY_PREFIX}recent.pdf`]);
  });

  it("nu atinge niciodată alte prefixe (public/, private/alt/, media), nici cu delete", async () => {
    const { storage, store, put } = fixture();
    put("public/media/2026/10/imagine.webp", OLD);
    put("private/digital/produs.zip", OLD);
    put("private/product-documents-alt/x.pdf", OLD); // prefix asemănător, dar altul
    put(`${DOCUMENT_KEY_PREFIX}orfan.pdf`, OLD);

    const report = await sweepOrphanDocuments({ storage, store, delete: true, now: () => NOW });
    expect(report.deleted).toEqual([`${DOCUMENT_KEY_PREFIX}orfan.pdf`]);
    expect([...storage.objects.keys()].sort()).toEqual([
      "private/digital/produs.zip",
      "private/product-documents-alt/x.pdf",
      "public/media/2026/10/imagine.webp",
    ]);
  });

  it("apărare în adâncime: un driver care întoarce o cheie din afara prefixului nu duce la ștergerea ei", async () => {
    const { storage, store, put } = fixture();
    put("public/media/a.webp", OLD);
    put(`${DOCUMENT_KEY_PREFIX}orfan.pdf`, OLD);
    // driver „defect”: ignoră prefixul
    storage.list = async () => ({
      objects: [...storage.objects.entries()].map(([key, o]) => ({
        key,
        size: o.body.length,
        lastModified: o.at,
      })),
      truncated: false,
    });
    const report = await sweepOrphanDocuments({ storage, store, delete: true, now: () => NOW });
    expect(report.deleted).toEqual([`${DOCUMENT_KEY_PREFIX}orfan.pdf`]);
    expect(storage.objects.has("public/media/a.webp")).toBe(true);
  });
});
