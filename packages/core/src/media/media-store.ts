import type { Prisma, PrismaClient } from "@ecom/db";

export interface NewMedia {
  mime: string;
  sizeBytes: number;
  width: number;
  height: number;
  checksum: string;
  originalName: string;
  storageKey: string;
  alt: string;
  folderId: string | null;
  uploadedById: string | null;
}

export interface MediaRow {
  id: string;
  status: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  storageKey: string;
  alt: string;
  folderId: string | null;
  createdAt: Date;
}

export interface MediaStore {
  create(data: NewMedia): Promise<MediaRow>;
  folderExists(id: string): Promise<boolean>;
}

const select = {
  id: true,
  status: true,
  mime: true,
  sizeBytes: true,
  width: true,
  height: true,
  storageKey: true,
  alt: true,
  folderId: true,
  createdAt: true,
} satisfies Prisma.MediaSelect;

export function createPrismaMediaStore(
  db: Pick<PrismaClient, "media" | "mediaFolder">,
): MediaStore {
  return {
    create: (data) => db.media.create({ data, select }),
    async folderExists(id) {
      return (await db.mediaFolder.count({ where: { id } })) > 0;
    },
  };
}
