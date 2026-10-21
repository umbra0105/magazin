import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@ecom/db";
import { isStorageError, type StorageDriver } from "@ecom/integrations";
import { DomainError, UnauthenticatedError, ValidationError, type getLogger } from "@ecom/shared";
import type { AuditService } from "../audit/audit-service";
import { isMediaError } from "../media/errors";
import { sanitizeFileName } from "../media/file-name";
import { sanitizeImage } from "../media/image";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { CATALOG_TAG, CatalogError, productCacheTags } from "./catalog-support";
import { PRODUCT_DOCUMENT_TYPES, type ProductDocumentType } from "./constants";
import { ProductUpdateGuard } from "./product-write";

/**
 * Documentele produsului (fișă tehnică, manual, declarație CE, etichetă energetică...). NU sunt
 * imagini din biblioteca media și nu apar în ea: stau sub `private/product-documents/`, cu cheia
 * generată de server (`<uuid>.<extensie>`), niciodată din numele trimis.
 *
 * Garanții (toate verificate de teste):
 * - **tipul vine din octeți**, nu din extensie sau `Content-Type`: PDF (`%PDF-` la început) sau
 *   PNG/JPEG/WebP (cu `file-type`, apoi re-codificate fără EXIF, ca la biblioteca media);
 * - **PDF cu conținut activ se refuză** (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`,
 *   `/RichMedia`, `/XFA`). Detectarea e PARȚIALĂ: caută marcajele în structura brută (inclusiv cu
 *   nume ofuscate prin `#xx`), dar nu vede marcajele din fluxuri comprimate. Sanitizarea completă
 *   (rescriere cu qpdf/ghostscript) e datorie notată; până atunci nimic nu execută PDF-ul: se
 *   servește doar ca descărcare (`attachment`, `nosniff`, CSP `sandbox`);
 * - **fără orfani:** la eroare după scrierea fișierului, fișierul se șterge; la ștergere/înlocuire,
 *   rândul din bază e sursa adevărului, iar fișierul vechi se șterge după aceea. Un obiect rămas
 *   totuși fără rând (cădere între pași, storage indisponibil) îl găsește `sweepOrphanDocuments`;
 * - audit fără conținut și fără numele fișierului; scrierile cer `products.content.write`.
 */

export const DOCUMENT_KEY_PREFIX = "private/product-documents/";
export const MAX_DOCUMENTS_PER_PRODUCT = 50;
/** Valabilitatea linkului semnat de descărcare. */
export const DOCUMENT_LINK_SECONDS = 120;

export type DocumentErrorCode =
  | "DOCUMENT_EMPTY"
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_TYPE_UNSUPPORTED"
  | "DOCUMENT_ACTIVE_CONTENT"
  | "DOCUMENT_CORRUPT"
  | "DOCUMENT_LIMIT"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_STORAGE_UNAVAILABLE";

/** Statusul HTTP potrivit fiecărui cod (folosit de ruta de upload). */
export const DOCUMENT_ERROR_STATUS: Record<DocumentErrorCode, number> = {
  DOCUMENT_EMPTY: 400,
  DOCUMENT_TOO_LARGE: 413,
  DOCUMENT_TYPE_UNSUPPORTED: 415,
  DOCUMENT_ACTIVE_CONTENT: 422,
  DOCUMENT_CORRUPT: 422,
  DOCUMENT_LIMIT: 422,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_STORAGE_UNAVAILABLE: 503,
};

export class DocumentError extends DomainError {
  declare readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message: string, details?: unknown) {
    super(code, message, details);
  }
}

export function isDocumentError(error: unknown): error is DocumentError {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof Error && typeof code === "string" && Object.hasOwn(DOCUMENT_ERROR_STATUS, code)
  );
}

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** Markerii de conținut activ dintr-un PDF. Numele sunt normalizate (fără `#xx`) înainte de căutare. */
const ACTIVE_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  { name: "JavaScript", pattern: /\/JavaScript(?![A-Za-z0-9])/ },
  { name: "JS", pattern: /\/JS(?![A-Za-z0-9])/ },
  { name: "Launch", pattern: /\/Launch(?![A-Za-z0-9])/ },
  { name: "EmbeddedFile", pattern: /\/EmbeddedFiles?(?![A-Za-z0-9])/ },
  { name: "RichMedia", pattern: /\/RichMedia(?![A-Za-z0-9])/ },
  { name: "XFA", pattern: /\/XFA(?![A-Za-z0-9])/ },
];

export function isPdf(bytes: Buffer): boolean {
  return bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * Marcajele de conținut activ găsite în structura BRUTĂ a unui PDF (listă goală = nimic găsit; NU
 * înseamnă „curat”: marcajele din fluxuri comprimate nu se văd fără un parser PDF).
 */
export function findPdfActiveContent(bytes: Buffer): string[] {
  // `latin1` păstrează 1 octet = 1 caracter; `#xx` din nume (ofuscare, ex. `/J#61vaScript`) se decodează.
  const text = bytes
    .toString("latin1")
    .replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  return ACTIVE_MARKERS.filter((m) => m.pattern.test(text)).map((m) => m.name);
}

export interface DocumentRecord {
  id: string;
  productId: string;
  type: ProductDocumentType;
  title: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  language: string;
  position: number;
  showInTab: boolean;
  createdAt: Date;
}

/** Rândul public: doar câmpurile `DocumentRecord`, fără cheia privată de stocare sau alte câmpuri interne. */
function toPublicRecord(row: DocumentRecord): DocumentRecord {
  return {
    id: row.id,
    productId: row.productId,
    type: row.type,
    title: row.title,
    originalName: row.originalName,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    language: row.language,
    position: row.position,
    showInTab: row.showInTab,
    createdAt: row.createdAt,
  };
}

interface NewDocumentRow {
  productId: string;
  type: ProductDocumentType;
  title: string;
  storageKey: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  language: string;
  showInTab: boolean;
}

export interface ProductDocumentStore {
  getProduct(id: string): Promise<{ id: string; slug: string; deletedAt: Date | null } | null>;
  list(productId: string): Promise<DocumentRecord[]>;
  count(productId: string): Promise<number>;
  /** Documentul, cu cheia de storage (nu iese din serviciu). */
  get(id: string): Promise<(DocumentRecord & { storageKey: string }) | null>;
  create(row: NewDocumentRow): Promise<DocumentRecord>;
  update(
    id: string,
    patch: Partial<Pick<DocumentRecord, "type" | "title" | "language" | "showInTab">>,
  ): Promise<DocumentRecord>;
  /** Pune fișierul nou pe rând și întoarce cheia veche. */
  replaceFile(
    id: string,
    file: { storageKey: string; originalName: string; mime: string; sizeBytes: number },
  ): Promise<{ record: DocumentRecord; previousKey: string }>;
  /** Șterge rândul și întoarce cheia fișierului. */
  delete(id: string): Promise<{ productId: string; storageKey: string } | null>;
  reorder(productId: string, orderedIds: readonly string[]): Promise<void>;
  /** Cheile de storage cunoscute (pentru compararea cu obiectele din stocare). */
  listStorageKeys(): Promise<string[]>;
}

export interface ProductDocumentsDeps {
  store: ProductDocumentStore;
  storage: StorageDriver;
  audit: AuditService;
  /** Limitele de imagine ale bibliotecii media (pixeli maximi la intrare). */
  getMaxInputPixels: () => Promise<number>;
  invalidate?: (tags: readonly string[]) => Promise<void> | void;
  logger: Pick<ReturnType<typeof getLogger>, "warn" | "error">;
}

const metaSchema = z.strictObject({
  type: z.enum(PRODUCT_DOCUMENT_TYPES),
  title: z.string().trim().min(1, "Titlul e obligatoriu").max(200).optional(),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}$/, "Limba e un cod din două litere (ro, en)")
    .optional(),
  showInTab: z.boolean().optional(),
});

const patchSchema = z
  .strictObject({
    type: z.enum(PRODUCT_DOCUMENT_TYPES).optional(),
    title: z.string().trim().min(1, "Titlul e obligatoriu").max(200).optional(),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/, "Limba e un cod din două litere (ro, en)")
      .optional(),
    showInTab: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nu a fost trimis niciun câmp de modificat",
  });

const NOT_FOUND = () => new DocumentError("DOCUMENT_NOT_FOUND", "Documentul nu mai există");

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  throw new ValidationError(`Date invalide: ${issues.map((i) => i.message).join("; ")}`, {
    issues,
  });
}

/** Numele fără extensie, ca titlu implicit. */
function titleFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.trim().slice(0, 200) || "Document";
}

export class ProductDocumentsService {
  private readonly guard: ProductUpdateGuard;

  constructor(private readonly deps: ProductDocumentsDeps) {
    this.guard = new ProductUpdateGuard({ audit: deps.audit });
  }

  private async invalidate(product: { id: string; slug: string }): Promise<void> {
    try {
      await this.deps.invalidate?.([...productCacheTags(product), CATALOG_TAG]);
    } catch (error) {
      this.deps.logger.warn(
        { reason: error instanceof Error ? error.message : "necunoscut" },
        "documente: invalidarea cache-ului a eșuat",
      );
    }
  }

  private async liveProduct(productId: string) {
    const product = await this.deps.store.getProduct(productId);
    if (!product) throw new CatalogError("CATALOG_PRODUCT_NOT_FOUND", "Produsul nu există");
    if (product.deletedAt) {
      throw new CatalogError(
        "CATALOG_PRODUCT_DELETED",
        "Produsul e șters; restaurează-l înainte să-l modifici",
      );
    }
    return product;
  }

  /**
   * Validează octeții și întoarce ce se stochează: PDF-ul neschimbat (după verificarea conținutului
   * activ) sau imaginea curățată. Aruncă `DocumentError` cu mesaj pentru administrator.
   */
  private async prepareFile(
    bytes: Buffer,
  ): Promise<{ body: Buffer; mime: string; extension: string }> {
    if (bytes.length === 0) throw new DocumentError("DOCUMENT_EMPTY", "Fișierul e gol");
    if (isPdf(bytes)) {
      const markers = findPdfActiveContent(bytes);
      if (markers.length > 0) {
        throw new DocumentError(
          "DOCUMENT_ACTIVE_CONTENT",
          "PDF-ul conține elemente active (JavaScript, fișiere atașate sau acțiuni de lansare) și nu poate fi încărcat. " +
            "Deschide-l într-un cititor PDF, alege „Tipărește” → „Salvează ca PDF”, apoi încarcă fișierul nou.",
          { markers },
        );
      }
      return { body: bytes, mime: "application/pdf", extension: "pdf" };
    }
    try {
      const image = await sanitizeImage(bytes, {
        allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
        maxInputPixels: await this.deps.getMaxInputPixels(),
      });
      return { body: image.buffer, mime: image.mime, extension: image.extension };
    } catch (error) {
      if (isMediaError(error)) {
        if (error.code === "MEDIA_UNSUPPORTED_TYPE") {
          throw new DocumentError(
            "DOCUMENT_TYPE_UNSUPPORTED",
            "Tipul fișierului nu este acceptat. Poți încărca PDF, PNG, JPEG sau WebP (tipul se verifică din conținut, nu din extensie).",
          );
        }
        if (error.code === "MEDIA_EMPTY") {
          throw new DocumentError("DOCUMENT_EMPTY", "Fișierul e gol");
        }
        throw new DocumentError(
          "DOCUMENT_CORRUPT",
          "Imaginea nu poate fi citită sau e prea mare. Încearcă un alt fișier.",
        );
      }
      throw error;
    }
  }

  /** Pune fișierul în stocare; erorile de infrastructură devin `DOCUMENT_STORAGE_UNAVAILABLE`. */
  private async putFile(key: string, body: Buffer, mime: string): Promise<void> {
    try {
      await this.deps.storage.put(key, body, {
        contentType: mime,
        cacheControl: "private, no-store",
      });
    } catch (error) {
      if (isStorageError(error)) {
        this.deps.logger.error({ code: error.code }, "documente: scrierea în stocare a eșuat");
        throw new DocumentError(
          "DOCUMENT_STORAGE_UNAVAILABLE",
          "Stocarea fișierelor nu este disponibilă momentan. Încearcă din nou peste puțin timp.",
        );
      }
      throw error;
    }
  }

  /** Șterge un obiect din stocare fără să arunce: un eșec lasă un orfan pentru `docs:sweep-orphans`. */
  private async removeFile(key: string, context: string): Promise<boolean> {
    try {
      await this.deps.storage.delete(key);
      return true;
    } catch (error) {
      this.deps.logger.warn(
        { key, context, reason: error instanceof Error ? error.message : "necunoscut" },
        "documente: ștergerea fișierului din stocare a eșuat (orfan; vezi docs:sweep-orphans)",
      );
      return false;
    }
  }

  async list(subject: PermissionSubject | null, productId: string): Promise<DocumentRecord[]> {
    assertCan(subject, "products.read");
    return this.deps.store.list(productId);
  }

  /**
   * Adaugă un document. `input`: `{ type, title?, language?, showInTab? }`; fișierul vine ca `bytes` și
   * `originalName` (deja sanitizat de apelant). Cere `products.content.write`.
   */
  async upload(
    subject: PermissionSubject | null,
    productId: string,
    file: { bytes: Buffer; originalName: string },
    input: unknown,
  ): Promise<DocumentRecord> {
    if (!subject) throw new UnauthenticatedError();
    const meta = parse(metaSchema, input);
    return this.guard.run(subject, { productId }, { documents: [meta.type] }, async () => {
      const product = await this.liveProduct(productId);
      if ((await this.deps.store.count(productId)) >= MAX_DOCUMENTS_PER_PRODUCT) {
        throw new DocumentError(
          "DOCUMENT_LIMIT",
          `Un produs poate avea cel mult ${MAX_DOCUMENTS_PER_PRODUCT} de documente`,
        );
      }
      const prepared = await this.prepareFile(file.bytes);
      const originalName = sanitizeFileName(file.originalName);
      const key = `${DOCUMENT_KEY_PREFIX}${randomUUID()}.${prepared.extension}`;

      await this.putFile(key, prepared.body, prepared.mime);
      let record: DocumentRecord;
      try {
        record = await this.deps.store.create({
          productId,
          type: meta.type,
          title: meta.title ?? titleFromName(originalName),
          storageKey: key,
          originalName,
          mime: prepared.mime,
          sizeBytes: prepared.body.length,
          language: meta.language ?? "ro",
          showInTab: meta.showInTab ?? true,
        });
      } catch (error) {
        // rândul nu s-a scris: fișierul pus adineauri nu are stăpân și se șterge acum
        await this.removeFile(key, "create_failed");
        throw error;
      }
      await this.deps.audit.record({
        actorId: subject.userId,
        actorLabel: subject.email,
        action: "product.document.upload",
        entity: "product",
        entityId: productId,
        after: {
          documentId: record.id,
          type: record.type,
          mime: record.mime,
          sizeBytes: record.sizeBytes,
        },
      });
      await this.invalidate(product);
      return record;
    });
  }

  /** Titlu, tip, limbă, afișare în tab. Cere `products.content.write`. */
  async update(
    subject: PermissionSubject | null,
    documentId: string,
    input: unknown,
  ): Promise<DocumentRecord> {
    if (!subject) throw new UnauthenticatedError();
    const patch = parse(patchSchema, input);
    const doc = await this.deps.store.get(documentId);
    if (!doc) throw NOT_FOUND();
    return this.guard.run(
      subject,
      { productId: doc.productId },
      { documents: Object.keys(patch) },
      async () => {
        const product = await this.liveProduct(doc.productId);
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const changes: typeof patch = {};
        for (const [key, value] of Object.entries(patch) as [keyof typeof patch, unknown][]) {
          if (value === undefined || doc[key] === value) continue;
          before[key] = doc[key];
          after[key] = value;
          (changes as Record<string, unknown>)[key] = value;
        }
        // `doc` vine din `store.get`, care include cheia privată de stocare: răspunsul ajunge în browser (C-21)
        if (Object.keys(changes).length === 0) return toPublicRecord(doc);
        const record = await this.deps.store.update(documentId, changes);
        await this.deps.audit.record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "product.document.update",
          entity: "product",
          entityId: doc.productId,
          before: { documentId, ...before },
          after,
        });
        await this.invalidate(product);
        return record;
      },
    );
  }

  /** Înlocuiește fișierul unui document; cel vechi se șterge din stocare după ce rândul e actualizat. */
  async replace(
    subject: PermissionSubject | null,
    productId: string,
    documentId: string,
    file: { bytes: Buffer; originalName: string },
  ): Promise<DocumentRecord> {
    if (!subject) throw new UnauthenticatedError();
    const doc = await this.deps.store.get(documentId);
    // documentul trebuie să aparțină produsului din cerere (un id străin nu se poate „împrumuta”)
    if (!doc || doc.productId !== productId) throw NOT_FOUND();
    return this.guard.run(
      subject,
      { productId: doc.productId },
      { documents: ["file"] },
      async () => {
        const product = await this.liveProduct(doc.productId);
        const prepared = await this.prepareFile(file.bytes);
        const key = `${DOCUMENT_KEY_PREFIX}${randomUUID()}.${prepared.extension}`;
        await this.putFile(key, prepared.body, prepared.mime);
        let replaced: { record: DocumentRecord; previousKey: string };
        try {
          replaced = await this.deps.store.replaceFile(documentId, {
            storageKey: key,
            originalName: sanitizeFileName(file.originalName),
            mime: prepared.mime,
            sizeBytes: prepared.body.length,
          });
        } catch (error) {
          await this.removeFile(key, "replace_failed");
          throw error;
        }
        await this.removeFile(replaced.previousKey, "replace_old_file");
        await this.deps.audit.record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "product.document.replace",
          entity: "product",
          entityId: doc.productId,
          after: {
            documentId,
            mime: replaced.record.mime,
            sizeBytes: replaced.record.sizeBytes,
          },
        });
        await this.invalidate(product);
        return replaced.record;
      },
    );
  }

  /** Șterge documentul: rândul, apoi fișierul din stocare. */
  async remove(subject: PermissionSubject | null, documentId: string): Promise<void> {
    if (!subject) throw new UnauthenticatedError();
    const doc = await this.deps.store.get(documentId);
    if (!doc) throw NOT_FOUND();
    await this.guard.run(
      subject,
      { productId: doc.productId },
      { documents: ["delete"] },
      async () => {
        const product = await this.deps.store.getProduct(doc.productId);
        const deleted = await this.deps.store.delete(documentId);
        if (!deleted) throw NOT_FOUND();
        await this.removeFile(deleted.storageKey, "delete");
        await this.deps.audit.record({
          actorId: subject.userId,
          actorLabel: subject.email,
          action: "product.document.delete",
          entity: "product",
          entityId: doc.productId,
          before: { documentId, type: doc.type, mime: doc.mime, sizeBytes: doc.sizeBytes },
        });
        if (product) await this.invalidate(product);
      },
    );
  }

  /** Ordinea documentelor produsului (lista trebuie să conțină exact documentele existente). */
  async reorder(
    subject: PermissionSubject | null,
    productId: string,
    orderedIds: readonly string[],
  ): Promise<DocumentRecord[]> {
    if (!subject) throw new UnauthenticatedError();
    return this.guard.run(subject, { productId }, { documents: ["reorder"] }, async () => {
      const product = await this.liveProduct(productId);
      const current = await this.deps.store.list(productId);
      const have = current.map((d) => d.id).sort();
      const want = [...orderedIds].sort();
      if (have.length !== want.length || have.some((v, i) => v !== want[i])) {
        throw new DocumentError(
          "DOCUMENT_NOT_FOUND",
          "Lista de documente s-a schimbat între timp. Reîncarcă pagina și reia",
        );
      }
      await this.deps.store.reorder(productId, orderedIds);
      await this.invalidate(product);
      return this.deps.store.list(productId);
    });
  }

  /**
   * Link de descărcare cu expirare scurtă (`attachment`, numele original). Cere `products.read`.
   * Documentul trebuie să aparțină produsului cerut.
   */
  async downloadLink(
    subject: PermissionSubject | null,
    productId: string,
    documentId: string,
  ): Promise<{ url: string }> {
    assertCan(subject, "products.read");
    const doc = await this.deps.store.get(documentId);
    if (!doc || doc.productId !== productId) throw NOT_FOUND();
    const url = await this.deps.storage.signedUrl(doc.storageKey, {
      expiresInSeconds: DOCUMENT_LINK_SECONDS,
      downloadFilename: doc.originalName,
    });
    return { url };
  }
}

// ---------------------------------------------------------------------------
// Orfani: obiecte din `private/product-documents/` fără rând în `product_document`
// ---------------------------------------------------------------------------

export interface OrphanReport {
  /** Obiecte din stocare, sub prefixul documentelor. */
  scanned: number;
  /** Obiecte fără rând și mai vechi decât pragul: candidați la ștergere. */
  orphans: { key: string; size: number; lastModified: Date }[];
  /** Obiecte fără rând, dar prea noi (poate un upload în curs): nu se ating. */
  tooRecent: number;
  /** Chei șterse (doar cu `delete: true`). */
  deleted: string[];
  truncated: boolean;
}

/**
 * Găsește (și opțional șterge) fișierele de documente rămase fără rând. Operează STRICT pe
 * `private/product-documents/`: listarea o face driverul pe acest prefix, iar ștergerea refuză orice
 * cheie din afara lui. Un obiect cu rând asociat nu e raportat niciodată. Doar obiectele mai vechi de
 * `olderThanMs` (implicit 1 oră) sunt candidate, ca un upload în curs să nu fie șters.
 */
export async function sweepOrphanDocuments(options: {
  storage: StorageDriver;
  store: Pick<ProductDocumentStore, "listStorageKeys">;
  delete?: boolean;
  olderThanMs?: number;
  now?: () => Date;
  limit?: number;
}): Promise<OrphanReport> {
  const olderThanMs = options.olderThanMs ?? 60 * 60 * 1000;
  const now = (options.now?.() ?? new Date()).getTime();
  const known = new Set(await options.store.listStorageKeys());
  const listing = await options.storage.list(DOCUMENT_KEY_PREFIX, {
    limit: options.limit ?? 10_000,
  });

  const report: OrphanReport = {
    scanned: listing.objects.length,
    orphans: [],
    tooRecent: 0,
    deleted: [],
    truncated: listing.truncated,
  };
  for (const object of listing.objects) {
    if (!object.key.startsWith(DOCUMENT_KEY_PREFIX)) continue; // apărare în adâncime
    if (known.has(object.key)) continue;
    if (now - object.lastModified.getTime() < olderThanMs) {
      report.tooRecent++;
      continue;
    }
    report.orphans.push(object);
  }
  if (options.delete) {
    for (const orphan of report.orphans) {
      if (!orphan.key.startsWith(DOCUMENT_KEY_PREFIX)) continue;
      await options.storage.delete(orphan.key);
      report.deleted.push(orphan.key);
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

type Db = PrismaClient | Prisma.TransactionClient;

async function inTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

const documentSelect = {
  id: true,
  productId: true,
  type: true,
  title: true,
  originalName: true,
  mime: true,
  sizeBytes: true,
  language: true,
  position: true,
  showInTab: true,
  createdAt: true,
} satisfies Prisma.ProductDocumentSelect;

type RawDocument = Prisma.ProductDocumentGetPayload<{ select: typeof documentSelect }>;

const toRecord = (row: RawDocument): DocumentRecord => ({
  ...row,
  type: row.type as ProductDocumentType,
});

export function createPrismaProductDocumentStore(db: Db): ProductDocumentStore {
  return {
    getProduct: (id) =>
      db.product.findUnique({ where: { id }, select: { id: true, slug: true, deletedAt: true } }),

    async list(productId) {
      const rows = await db.productDocument.findMany({
        where: { productId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: documentSelect,
      });
      return rows.map(toRecord);
    },

    count: (productId) => db.productDocument.count({ where: { productId } }),

    async get(id) {
      const row = await db.productDocument.findUnique({
        where: { id },
        select: { ...documentSelect, storageKey: true },
      });
      return row ? { ...toRecord(row), storageKey: row.storageKey } : null;
    },

    async create(row) {
      return inTransaction(db, async (tx) => {
        const last = await tx.productDocument.findFirst({
          where: { productId: row.productId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        const created = await tx.productDocument.create({
          data: { ...row, position: (last?.position ?? -1) + 1 },
          select: documentSelect,
        });
        return toRecord(created);
      });
    },

    async update(id, patch) {
      const row = await db.productDocument.update({
        where: { id },
        data: patch,
        select: documentSelect,
      });
      return toRecord(row);
    },

    async replaceFile(id, file) {
      return inTransaction(db, async (tx) => {
        const before = await tx.productDocument.findUniqueOrThrow({
          where: { id },
          select: { storageKey: true },
        });
        const row = await tx.productDocument.update({
          where: { id },
          data: file,
          select: documentSelect,
        });
        return { record: toRecord(row), previousKey: before.storageKey };
      });
    },

    async delete(id) {
      const row = await db.productDocument.findUnique({
        where: { id },
        select: { productId: true, storageKey: true },
      });
      if (!row) return null;
      await db.productDocument.delete({ where: { id } });
      return row;
    },

    async reorder(productId, orderedIds) {
      await inTransaction(db, async (tx) => {
        for (const [position, id] of orderedIds.entries()) {
          await tx.productDocument.updateMany({ where: { id, productId }, data: { position } });
        }
      });
    },

    async listStorageKeys() {
      const rows = await db.productDocument.findMany({ select: { storageKey: true } });
      return rows.map((r) => r.storageKey);
    },
  };
}
