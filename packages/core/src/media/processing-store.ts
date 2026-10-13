import type { Prisma, PrismaClient } from "@ecom/db";
import type { MediaProcessingStore, StoredVariant } from "./processing";

type Db = Pick<PrismaClient, "media">;

function parseVariants(value: unknown): StoredVariant[] {
  return Array.isArray(value) ? (value as StoredVariant[]) : [];
}

export function createPrismaProcessingStore(db: Db): MediaProcessingStore {
  return {
    async get(id) {
      const row = await db.media.findUnique({
        where: { id },
        select: { id: true, status: true, storageKey: true, variants: true },
      });
      return row ? { ...row, variants: parseVariants(row.variants) } : null;
    },
    async markPending(id) {
      await db.media.update({ where: { id }, data: { status: "pending", processingError: null } });
    },
    async markProcessing(id) {
      await db.media.update({ where: { id }, data: { status: "processing" } });
    },
    async markRetrying(id, code) {
      await db.media.update({ where: { id }, data: { status: "pending", processingError: code } });
    },
    async markReady(id, result) {
      await db.media.update({
        where: { id },
        data: {
          status: "ready",
          processingError: null,
          variants: result.variants as unknown as Prisma.InputJsonValue,
          blurhash: result.blurhash,
          width: result.width,
          height: result.height,
        },
      });
    },
    async markFailed(id, code) {
      await db.media.update({ where: { id }, data: { status: "failed", processingError: code } });
    },
  };
}
