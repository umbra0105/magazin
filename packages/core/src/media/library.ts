import { DomainError, ValidationError, getLogger } from "@ecom/shared";
import type { StorageDriver } from "@ecom/integrations";
import type { AuditService } from "../audit/audit-service";
import { assertCan, type PermissionSubject } from "../rbac/can";
import { blurhashToDataUrl } from "./placeholder";
import {
  requestMediaProcessing,
  type MediaJobQueue,
  type MediaProcessingStore,
  type StoredVariant,
} from "./processing";
import { normalizeAlt, normalizeFolderName, normalizeTags } from "./tags";
import type { MediaUsage, MediaUsageRegistry } from "./usage";

export const MEDIA_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type MediaListStatus = (typeof MEDIA_STATUSES)[number];

export const MAX_FOLDER_DEPTH = 5;
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

export type MediaLibraryErrorCode =
  "MEDIA_NOT_FOUND" | "FOLDER_NOT_FOUND" | "FOLDER_NAME_TAKEN" | "FOLDER_CYCLE" | "FOLDER_TOO_DEEP";

export class MediaLibraryError extends DomainError {
  declare readonly code: MediaLibraryErrorCode;
  constructor(code: MediaLibraryErrorCode, message: string) {
    super(code, message);
  }
}

/** Fișierul e folosit: ștergerea se refuză, cu lista locurilor. */
export class MediaInUseError extends DomainError {
  constructor(readonly usages: readonly MediaUsage[]) {
    super("MEDIA_IN_USE", "Fișierul este folosit și nu poate fi șters", { count: usages.length });
  }
}

/** Rând din baza de date, cu tot ce trebuie bibliotecii (fără nimic secret). */
export interface LibraryRow {
  id: string;
  status: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  originalName: string;
  alt: string;
  tags: string[];
  folderId: string | null;
  storageKey: string;
  variants: unknown;
  processingError: string | null;
  createdAt: Date;
}

export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
  mediaCount: number;
}

export interface LibraryQuery {
  q?: string;
  /** `"root"` = fără folder; un id = acel folder; lipsă = toate. */
  folder?: string;
  status?: MediaListStatus;
  page?: number;
  pageSize?: number;
}

export interface MediaLibraryStore {
  list(filter: {
    q: string | null;
    folder: string | null | "all";
    status: MediaListStatus | null;
    skip: number;
    take: number;
  }): Promise<{ rows: LibraryRow[]; total: number }>;
  get(id: string): Promise<LibraryRow | null>;
  getMany(ids: readonly string[]): Promise<LibraryRow[]>;
  update(
    id: string,
    patch: { alt?: string; tags?: string[]; folderId?: string | null },
  ): Promise<LibraryRow>;
  delete(id: string): Promise<void>;
  listFolders(): Promise<LibraryFolder[]>;
  createFolder(name: string, parentId: string | null): Promise<LibraryFolder>;
  updateFolder(
    id: string,
    patch: { name?: string; parentId?: string | null },
  ): Promise<LibraryFolder>;
}

/** Ce ajunge în browser pentru fiecare fișier: NICIODATĂ cheia de storage sau originalul. */
export interface LibraryItem {
  id: string;
  status: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  originalName: string;
  alt: string;
  tags: string[];
  folderId: string | null;
  processingError: string | null;
  createdAt: string;
  /** Varianta `thumb` (WebP, altfel JPEG/AVIF); `null` cât timp nu e procesat. */
  thumb: { url: string; width: number; height: number } | null;
  /** PNG minuscul (`data:`) calculat din blurhash. */
  placeholder: string | null;
}

export interface LibraryPage {
  items: LibraryItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface MediaLibraryDeps {
  store: MediaLibraryStore;
  storage: StorageDriver;
  audit: AuditService;
  usage: MediaUsageRegistry;
  processing: Pick<MediaProcessingStore, "markPending">;
  queue: MediaJobQueue;
}

const THUMB_FORMATS = ["webp", "jpeg", "avif"];

function variantsOf(value: unknown): StoredVariant[] {
  return Array.isArray(value) ? (value as StoredVariant[]) : [];
}

const actorOf = (subject: PermissionSubject) => ({
  actorId: subject.userId,
  actorLabel: subject.email,
});

/**
 * Biblioteca media din admin. Fiecare metodă verifică ea însăși permisiunea (`media.read` pentru
 * citire, `media.write` pentru orice modificare), în plus față de `withPermission` din acțiunile
 * de server: o a doua barieră, în `packages/core`, nu în UI. Orice scriere intră în jurnalul de audit.
 */
export class MediaLibraryService {
  constructor(private readonly deps: MediaLibraryDeps) {}

  private async toItem(row: LibraryRow): Promise<LibraryItem> {
    const variants = variantsOf(row.variants).filter((v) => v.name === "thumb");
    const chosen =
      THUMB_FORMATS.map((f) => variants.find((v) => v.format === f)).find(Boolean) ?? null;
    return {
      id: row.id,
      status: row.status,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      originalName: row.originalName,
      alt: row.alt,
      tags: row.tags,
      folderId: row.folderId,
      processingError: row.processingError,
      createdAt: row.createdAt.toISOString(),
      thumb: chosen
        ? {
            url: this.deps.storage.publicUrl(chosen.key),
            width: chosen.width,
            height: chosen.height,
          }
        : null,
      placeholder: await blurhashToDataUrl(row.blurhash),
    };
  }

  async list(subject: PermissionSubject, query: LibraryQuery = {}): Promise<LibraryPage> {
    assertCan(subject, "media.read");
    const pageSize = Math.min(
      Math.max(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );
    const requested = Math.max(Math.trunc(query.page ?? 1), 1);
    const q = (query.q ?? "").trim().slice(0, 100);
    const folder =
      query.folder === undefined ? "all" : query.folder === "root" ? null : query.folder;
    const status = query.status && MEDIA_STATUSES.includes(query.status) ? query.status : null;

    const filter = { q: q === "" ? null : q, folder, status };
    let { rows, total } = await this.deps.store.list({
      ...filter,
      skip: (requested - 1) * pageSize,
      take: pageSize,
    });
    const pageCount = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(requested, pageCount);
    if (page !== requested) {
      ({ rows, total } = await this.deps.store.list({
        ...filter,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }));
    }
    return {
      items: await Promise.all(rows.map((r) => this.toItem(r))),
      total,
      page,
      pageSize,
      pageCount,
    };
  }

  /** Doar ce se schimbă în timp (pentru actualizarea automată a statusului). */
  async statuses(subject: PermissionSubject, ids: readonly string[]): Promise<LibraryItem[]> {
    assertCan(subject, "media.read");
    if (ids.length === 0) return [];
    const rows = await this.deps.store.getMany(ids.slice(0, MAX_PAGE_SIZE));
    return Promise.all(rows.map((r) => this.toItem(r)));
  }

  async folders(subject: PermissionSubject): Promise<LibraryFolder[]> {
    assertCan(subject, "media.read");
    return this.deps.store.listFolders();
  }

  async update(
    subject: PermissionSubject,
    id: string,
    patch: { alt?: string; tags?: string[]; folderId?: string | null },
  ): Promise<LibraryItem> {
    assertCan(subject, "media.write");
    const before = await this.deps.store.get(id);
    if (!before) throw new MediaLibraryError("MEDIA_NOT_FOUND", "Fișierul nu există");

    const next: { alt?: string; tags?: string[]; folderId?: string | null } = {};
    if (patch.alt !== undefined) next.alt = normalizeAlt(patch.alt);
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
    if (patch.folderId !== undefined) {
      if (patch.folderId !== null) await this.requireFolder(patch.folderId);
      next.folderId = patch.folderId;
    }
    const after = await this.deps.store.update(id, next);

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    if (next.alt !== undefined && next.alt !== before.alt)
      changed["alt"] = { before: before.alt, after: after.alt };
    if (next.tags !== undefined && next.tags.join("\u0000") !== before.tags.join("\u0000")) {
      changed["tags"] = { before: before.tags, after: after.tags };
    }
    if (next.folderId !== undefined && next.folderId !== before.folderId) {
      changed["folderId"] = { before: before.folderId, after: after.folderId };
    }
    if (Object.keys(changed).length > 0) {
      await this.record(subject, "media.update", "media", id, {
        before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before])),
        after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after])),
      });
    }
    return this.toItem(after);
  }

  /**
   * Șterge un fișier: refuză cu `MediaInUseError` dacă un provider îl raportează folosit; altfel
   * șterge rândul și apoi toate obiectele din storage (original și variante). Obiectele rămase
   * dacă storage-ul cade nu mai sunt referite de nimic și se raportează în loguri.
   */
  async delete(subject: PermissionSubject, id: string): Promise<void> {
    assertCan(subject, "media.write");
    const row = await this.deps.store.get(id);
    if (!row) throw new MediaLibraryError("MEDIA_NOT_FOUND", "Fișierul nu există");

    const usages = (await this.deps.usage.findUsages([id])).get(id) ?? [];
    if (usages.length > 0) throw new MediaInUseError(usages);

    await this.deps.store.delete(id);
    const keys = [row.storageKey, ...variantsOf(row.variants).map((v) => v.key)];
    const results = await Promise.allSettled(keys.map((key) => this.deps.storage.delete(key)));
    const orphaned = results.filter((r) => r.status === "rejected").length;
    if (orphaned > 0) {
      getLogger().error(
        { mediaId: id, orphaned },
        "media: obiecte rămase în storage după ștergere",
      );
    }
    await this.record(subject, "media.delete", "media", id, {
      before: {
        mime: row.mime,
        sizeBytes: row.sizeBytes,
        folderId: row.folderId,
        objects: keys.length,
      },
      after: { orphanedObjects: orphaned },
    });
  }

  async regenerate(subject: PermissionSubject, id: string): Promise<void> {
    assertCan(subject, "media.write");
    const row = await this.deps.store.get(id);
    if (!row) throw new MediaLibraryError("MEDIA_NOT_FOUND", "Fișierul nu există");
    await requestMediaProcessing({ store: this.deps.processing, queue: this.deps.queue }, id);
    await this.record(subject, "media.regenerate", "media", id, {
      before: { status: row.status },
    });
  }

  async createFolder(
    subject: PermissionSubject,
    name: string,
    parentId: string | null,
  ): Promise<LibraryFolder> {
    assertCan(subject, "media.write");
    const clean = normalizeFolderName(name);
    const folders = await this.deps.store.listFolders();
    if (parentId !== null) {
      if (!folders.some((f) => f.id === parentId)) {
        throw new MediaLibraryError("FOLDER_NOT_FOUND", "Folderul părinte nu există");
      }
      if (depthOf(folders, parentId) + 1 > MAX_FOLDER_DEPTH) {
        throw new MediaLibraryError(
          "FOLDER_TOO_DEEP",
          `Cel mult ${MAX_FOLDER_DEPTH} niveluri de foldere`,
        );
      }
    }
    const created = await this.guardName(() => this.deps.store.createFolder(clean, parentId));
    await this.record(subject, "media_folder.create", "media_folder", created.id, {
      after: { name: created.name, parentId },
    });
    return created;
  }

  async renameFolder(subject: PermissionSubject, id: string, name: string): Promise<LibraryFolder> {
    assertCan(subject, "media.write");
    const clean = normalizeFolderName(name);
    const folders = await this.deps.store.listFolders();
    const current = folders.find((f) => f.id === id);
    if (!current) throw new MediaLibraryError("FOLDER_NOT_FOUND", "Folderul nu există");
    if (current.name === clean) return current;
    const updated = await this.guardName(() => this.deps.store.updateFolder(id, { name: clean }));
    await this.record(subject, "media_folder.rename", "media_folder", id, {
      before: { name: current.name },
      after: { name: clean },
    });
    return updated;
  }

  /** Mută un folder sub alt părinte (sau în rădăcină cu `null`), fără cicluri și fără a depăși adâncimea. */
  async moveFolder(
    subject: PermissionSubject,
    id: string,
    parentId: string | null,
  ): Promise<LibraryFolder> {
    assertCan(subject, "media.write");
    const folders = await this.deps.store.listFolders();
    const current = folders.find((f) => f.id === id);
    if (!current) throw new MediaLibraryError("FOLDER_NOT_FOUND", "Folderul nu există");
    if (parentId !== null && !folders.some((f) => f.id === parentId)) {
      throw new MediaLibraryError("FOLDER_NOT_FOUND", "Folderul părinte nu există");
    }
    if (current.parentId === parentId) return current;
    if (parentId !== null) {
      // nu în el însuși, nici într-un descendent al lui
      let cursor: string | null = parentId;
      while (cursor !== null) {
        if (cursor === id)
          throw new MediaLibraryError(
            "FOLDER_CYCLE",
            "Un folder nu poate fi mutat în el însuși sau într-un subfolder al lui",
          );
        cursor = folders.find((f) => f.id === cursor)?.parentId ?? null;
      }
      const newDepth = depthOf(folders, parentId) + 1 + subtreeHeight(folders, id);
      if (newDepth > MAX_FOLDER_DEPTH) {
        throw new MediaLibraryError(
          "FOLDER_TOO_DEEP",
          `Cel mult ${MAX_FOLDER_DEPTH} niveluri de foldere`,
        );
      }
    }
    const updated = await this.guardName(() => this.deps.store.updateFolder(id, { parentId }));
    await this.record(subject, "media_folder.move", "media_folder", id, {
      before: { parentId: current.parentId },
      after: { parentId },
    });
    return updated;
  }

  private async requireFolder(id: string): Promise<void> {
    const folders = await this.deps.store.listFolders();
    if (!folders.some((f) => f.id === id)) {
      throw new MediaLibraryError("FOLDER_NOT_FOUND", "Folderul nu există");
    }
  }

  private async guardName<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      const code = error as {
        code?: string;
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
      };
      const unique =
        code.code === "P2002" ||
        code.meta?.driverAdapterError?.cause?.originalCode === "23505" ||
        /unique|duplicate/i.test((error as Error).message ?? "");
      if (unique) {
        throw new MediaLibraryError(
          "FOLDER_NAME_TAKEN",
          "Există deja un folder cu acest nume în acest loc",
        );
      }
      throw error;
    }
  }

  private async record(
    subject: PermissionSubject,
    action: string,
    entity: string,
    entityId: string,
    data: { before?: unknown; after?: unknown },
  ): Promise<void> {
    try {
      await this.deps.audit.record({ ...actorOf(subject), action, entity, entityId, ...data });
    } catch (error) {
      getLogger().error({ err: error, action, entity }, "scrierea în jurnalul de audit a eșuat");
      throw new DomainError(
        "AUDIT_WRITE_FAILED",
        "Acțiunea a fost executată, dar nu a putut fi înregistrată în jurnalul de audit",
      );
    }
  }
}

/** Numărul de niveluri de la rădăcină până la `id` inclusiv (rădăcina = 1). */
function depthOf(folders: readonly LibraryFolder[], id: string): number {
  let depth = 0;
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = folders.find((f) => f.id === cursor)?.parentId ?? null;
  }
  return depth;
}

/** Câte niveluri sub `id` (0 = fără subfoldere). */
function subtreeHeight(folders: readonly LibraryFolder[], id: string): number {
  const children = folders.filter((f) => f.parentId === id);
  return children.length === 0
    ? 0
    : 1 + Math.max(...children.map((c) => subtreeHeight(folders, c.id)));
}

export { ValidationError };
