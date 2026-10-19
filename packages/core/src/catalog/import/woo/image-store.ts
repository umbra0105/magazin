import type { Prisma, PrismaClient } from "@ecom/db";

/**
 * Sarcinile de descărcare a imaginilor unui import (`ProductImportImage`) și citirile de care are nevoie
 * descărcarea: ce fișier există deja pentru o adresă, ce imagini are produsul, titlul produsului (pentru textul
 * alternativ). Niciun IP, antet sau corp de răspuns nu se scrie aici: motivul unui eșec e un COD stabil.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type ImageTaskStatus = "pending" | "downloaded" | "existing" | "failed";

export interface ImageTask {
  id: string;
  importId: string;
  productId: string;
  row: number;
  sku: string;
  position: number;
  sourceUrl: string;
  sourceHash: string;
  host: string;
  status: ImageTaskStatus;
  reason: string | null;
}

export interface NewImageTask {
  productId: string;
  row: number;
  sku: string;
  position: number;
  sourceUrl: string;
  sourceHash: string;
  host: string;
}

export interface ImageProgress {
  pending: number;
  downloaded: number;
  existing: number;
  failed: number;
  /** Ultima modificare a unei sarcini: dacă sunt sarcini în așteptare și nimic nu se mișcă, jobul s-a oprit. */
  lastActivity: Date | null;
}

export interface ImageFailure {
  row: number;
  sku: string;
  host: string;
  reason: string;
}

export interface MediaBrief {
  id: string;
  status: string;
}

export interface ImageTaskStore {
  insertTasks(importId: string, tasks: readonly NewImageTask[]): Promise<number>;
  /** Sarcinile unui import, în ordinea produs → poziție. */
  listTasks(importId: string, statuses: readonly ImageTaskStatus[]): Promise<ImageTask[]>;
  setResult(
    taskId: string,
    result: { status: ImageTaskStatus; reason: string | null },
  ): Promise<void>;
  /** Eșuatele devin din nou în așteptare (reîncercare). Întoarce câte. */
  resetFailed(importId: string): Promise<number>;
  progress(importIds: readonly string[]): Promise<Map<string, ImageProgress>>;
  failures(importId: string, limit: number): Promise<ImageFailure[]>;
  findMediaBySourceHash(hash: string): Promise<MediaBrief | null>;
  /** Fișierele aduse de la adresele date (după hash-ul adresei sursă, unic pe `Media`). */
  findMediaBySourceHashes(hashes: readonly string[]): Promise<Map<string, MediaBrief>>;
  /** Fișierele media ale produsului (fără cele ale variantelor), în ordinea afișării. */
  productMediaIds(productId: string): Promise<string[]>;
  productTitles(productIds: readonly string[]): Promise<Map<string, string>>;
}

const CHUNK = 1000;

export function createImageTaskStore(db: Db): ImageTaskStore {
  const toTask = (row: {
    id: string;
    importId: string;
    productId: string;
    row: number;
    sku: string;
    position: number;
    sourceUrl: string;
    sourceHash: string;
    host: string;
    status: string;
    reason: string | null;
  }): ImageTask => ({ ...row, status: row.status as ImageTaskStatus });

  return {
    async insertTasks(importId, tasks) {
      let inserted = 0;
      for (let i = 0; i < tasks.length; i += CHUNK) {
        const part = tasks.slice(i, i + CHUNK);
        const result = await db.productImportImage.createMany({
          data: part.map((task) => ({ importId, ...task })),
        });
        inserted += result.count;
      }
      return inserted;
    },

    async listTasks(importId, statuses) {
      const rows = await db.productImportImage.findMany({
        where: { importId, status: { in: [...statuses] } },
        orderBy: [{ productId: "asc" }, { position: "asc" }],
        select: {
          id: true,
          importId: true,
          productId: true,
          row: true,
          sku: true,
          position: true,
          sourceUrl: true,
          sourceHash: true,
          host: true,
          status: true,
          reason: true,
        },
      });
      return rows.map(toTask);
    },

    async setResult(taskId, result) {
      await db.productImportImage.update({ where: { id: taskId }, data: result });
    },

    async resetFailed(importId) {
      const result = await db.productImportImage.updateMany({
        where: { importId, status: "failed" },
        data: { status: "pending", reason: null },
      });
      return result.count;
    },

    async progress(importIds) {
      const out = new Map<string, ImageProgress>();
      if (importIds.length === 0) return out;
      const groups = await db.productImportImage.groupBy({
        by: ["importId", "status"],
        where: { importId: { in: [...importIds] } },
        _count: { _all: true },
        _max: { updatedAt: true },
      });
      for (const group of groups) {
        const entry = out.get(group.importId) ?? {
          pending: 0,
          downloaded: 0,
          existing: 0,
          failed: 0,
          lastActivity: null,
        };
        const count = group._count._all;
        if (group.status === "pending") entry.pending += count;
        else if (group.status === "downloaded") entry.downloaded += count;
        else if (group.status === "existing") entry.existing += count;
        else if (group.status === "failed") entry.failed += count;
        const touched = group._max.updatedAt;
        if (touched && (!entry.lastActivity || touched > entry.lastActivity)) {
          entry.lastActivity = touched;
        }
        out.set(group.importId, entry);
      }
      return out;
    },

    async failures(importId, limit) {
      return db.productImportImage.findMany({
        where: { importId, status: "failed" },
        orderBy: [{ row: "asc" }, { position: "asc" }],
        take: limit,
        select: { row: true, sku: true, host: true, reason: true },
      }) as Promise<ImageFailure[]>;
    },

    async findMediaBySourceHash(hash) {
      return db.media.findUnique({
        where: { sourceHash: hash },
        select: { id: true, status: true },
      });
    },

    async findMediaBySourceHashes(hashes) {
      const out = new Map<string, MediaBrief>();
      for (let i = 0; i < hashes.length; i += CHUNK) {
        const rows = await db.media.findMany({
          where: { sourceHash: { in: hashes.slice(i, i + CHUNK) as string[] } },
          select: { id: true, status: true, sourceHash: true },
        });
        for (const row of rows) {
          if (row.sourceHash) out.set(row.sourceHash, { id: row.id, status: row.status });
        }
      }
      return out;
    },

    async productMediaIds(productId) {
      const rows = await db.productMedia.findMany({
        where: { productId, variantId: null },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { mediaId: true },
      });
      return rows.map((row) => row.mediaId);
    },

    async productTitles(productIds) {
      const out = new Map<string, string>();
      for (let i = 0; i < productIds.length; i += CHUNK) {
        const rows = await db.product.findMany({
          where: { id: { in: productIds.slice(i, i + CHUNK) } },
          select: { id: true, title: true },
        });
        for (const row of rows) out.set(row.id, row.title);
      }
      return out;
    },
  };
}
