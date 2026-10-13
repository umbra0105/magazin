import type { Prisma, PrismaClient } from "@ecom/db";
import type { LibraryFolder, LibraryRow, MediaLibraryStore } from "./library";

type Db = Pick<PrismaClient, "media" | "mediaFolder">;

const select = {
  id: true,
  status: true,
  mime: true,
  sizeBytes: true,
  width: true,
  height: true,
  blurhash: true,
  originalName: true,
  alt: true,
  tags: true,
  folderId: true,
  storageKey: true,
  variants: true,
  processingError: true,
  createdAt: true,
} satisfies Prisma.MediaSelect;

export function createPrismaLibraryStore(db: Db): MediaLibraryStore {
  const folderWithCount = async (id: string): Promise<LibraryFolder> => {
    const f = await db.mediaFolder.findUniqueOrThrow({
      where: { id },
      select: { id: true, name: true, parentId: true, _count: { select: { media: true } } },
    });
    return { id: f.id, name: f.name, parentId: f.parentId, mediaCount: f._count.media };
  };

  return {
    async list({ q, folder, status, skip, take }) {
      const and: Prisma.MediaWhereInput[] = [];
      if (folder !== "all") and.push({ folderId: folder });
      if (status) and.push({ status });
      if (q) {
        and.push({
          OR: [
            { originalName: { contains: q, mode: "insensitive" } },
            { alt: { contains: q, mode: "insensitive" } },
            { tags: { has: q.toLowerCase() } },
          ],
        });
      }
      const where: Prisma.MediaWhereInput = and.length > 0 ? { AND: and } : {};
      const [rows, total] = await Promise.all([
        db.media.findMany({
          where,
          select,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip,
          take,
        }),
        db.media.count({ where }),
      ]);
      return { rows, total };
    },
    get: (id) => db.media.findUnique({ where: { id }, select }),
    getMany: (ids) => db.media.findMany({ where: { id: { in: [...ids] } }, select }),
    update: (id, patch) => db.media.update({ where: { id }, data: patch, select }),
    async delete(id) {
      await db.media.delete({ where: { id } });
    },
    async listFolders() {
      const rows = await db.mediaFolder.findMany({
        select: { id: true, name: true, parentId: true, _count: { select: { media: true } } },
        orderBy: { name: "asc" },
      });
      return rows.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        mediaCount: f._count.media,
      }));
    },
    async createFolder(name, parentId) {
      const created = await db.mediaFolder.create({
        data: { name, parentId },
        select: { id: true },
      });
      return folderWithCount(created.id);
    },
    async updateFolder(id, patch) {
      await db.mediaFolder.update({ where: { id }, data: patch });
      return folderWithCount(id);
    },
  };
}

export type { LibraryRow };
