-- CreateTable
CREATE TABLE "media_folder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "blurhash" TEXT,
    "alt" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "folderId" TEXT,
    "processingError" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_folder_parentId_idx" ON "media_folder"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "media_storageKey_key" ON "media"("storageKey");

-- CreateIndex
CREATE INDEX "media_folderId_idx" ON "media"("folderId");

-- CreateIndex
CREATE INDEX "media_status_idx" ON "media"("status");

-- CreateIndex
CREATE INDEX "media_checksum_idx" ON "media"("checksum");

-- CreateIndex
CREATE INDEX "media_createdAt_idx" ON "media"("createdAt");

-- CreateIndex
CREATE INDEX "media_uploadedById_idx" ON "media"("uploadedById");

-- AddForeignKey
ALTER TABLE "media_folder" ADD CONSTRAINT "media_folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "media_folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "media_folder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Valorile permise pentru status (același set ca în MediaStatus din @ecom/core)
ALTER TABLE "media"
  ADD CONSTRAINT "media_status_check" CHECK ("status" IN ('pending', 'processing', 'ready', 'failed'));

ALTER TABLE "media"
  ADD CONSTRAINT "media_sizeBytes_check" CHECK ("sizeBytes" >= 0);

-- Numele unui folder e unic în același părinte, fără diferență de majuscule.
-- Două indexuri, fiindcă în Postgres NULL nu intră în comparația UNIQUE (folderele din rădăcină).
CREATE UNIQUE INDEX "media_folder_name_in_parent_key"
  ON "media_folder" ("parentId", lower("name")) WHERE "parentId" IS NOT NULL;
CREATE UNIQUE INDEX "media_folder_name_in_root_key"
  ON "media_folder" (lower("name")) WHERE "parentId" IS NULL;

-- Filtrarea după taguri (tags @> ARRAY['x'])
CREATE INDEX "media_tags_idx" ON "media" USING GIN ("tags");
