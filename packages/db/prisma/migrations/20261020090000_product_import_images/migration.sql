-- Importul de imagini prin adresă (Faza 4, punctul 15b): hash-ul adresei sursă pe fișierul media (idempotență) și
-- sarcinile de descărcare ale unui import. Adresele au trecut deja de verificările de securitate (https, domeniu permis);
-- motivul unui eșec e un cod stabil. Sarcina NU are cheie străină spre `media` (ar conta ca utilizare a fișierului și i-ar
-- bloca ștergerea): fișierul se regăsește prin hash-ul adresei sursă (`media.sourceHash`, unic).

-- AlterTable
ALTER TABLE "media" ADD COLUMN "sourceHash" TEXT;

-- CreateIndex (unic: aceeași adresă sursă nu produce un al doilea fișier, nici la importuri paralele)
CREATE UNIQUE INDEX "media_sourceHash_key" ON "media"("sourceHash");

-- CreateTable
CREATE TABLE "product_import_image" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "row" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_import_image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_import_image_importId_status_idx" ON "product_import_image"("importId", "status");

-- CreateIndex
CREATE INDEX "product_import_image_productId_idx" ON "product_import_image"("productId");

-- AddForeignKey
ALTER TABLE "product_import_image" ADD CONSTRAINT "product_import_image_importId_fkey" FOREIGN KEY ("importId") REFERENCES "product_import"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_import_image" ADD CONSTRAINT "product_import_image_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Valorile permise. Fiecare CHECK privește o singură coloană și tratează explicit NULL.
ALTER TABLE "product_import_image"
  ADD CONSTRAINT "product_import_image_status_check"
    CHECK ("status" IN ('pending', 'downloaded', 'existing', 'failed')),
  ADD CONSTRAINT "product_import_image_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "product_import_image_row_check" CHECK ("row" > 0),
  ADD CONSTRAINT "product_import_image_sourceHash_check" CHECK ("sourceHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "product_import_image_reason_check"
    CHECK ("reason" IS NULL OR "reason" ~ '^[a-z_]{1,40}$');
ALTER TABLE "media"
  ADD CONSTRAINT "media_sourceHash_check"
    CHECK ("sourceHash" IS NULL OR "sourceHash" ~ '^[0-9a-f]{64}$');
