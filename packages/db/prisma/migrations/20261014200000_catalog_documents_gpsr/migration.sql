-- AlterTable
ALTER TABLE "product" ADD COLUMN     "allowBackorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "energyClass" TEXT,
ADD COLUMN     "eprelUrl" TEXT,
ADD COLUMN     "expectedRestockDate" TIMESTAMP(3),
ADD COLUMN     "gpsrManufacturerContact" TEXT,
ADD COLUMN     "gpsrManufacturerName" TEXT,
ADD COLUMN     "gpsrResponsibleContact" TEXT,
ADD COLUMN     "gpsrResponsibleName" TEXT,
ADD COLUMN     "safetyWarnings" TEXT;

-- AlterTable
ALTER TABLE "product_variant" ADD COLUMN     "manufacturerName" TEXT,
ADD COLUMN     "manufacturerPartNumber" TEXT;

-- CreateTable
CREATE TABLE "product_document" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ro',
    "position" INTEGER NOT NULL DEFAULT 0,
    "showInTab" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts_diagram" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parts_diagram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts_diagram_product" (
    "diagramId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "parts_diagram_product_pkey" PRIMARY KEY ("diagramId","productId")
);

-- CreateTable
CREATE TABLE "parts_diagram_hotspot" (
    "id" TEXT NOT NULL,
    "diagramId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "xBp" INTEGER,
    "yBp" INTEGER,
    "productId" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "parts_diagram_hotspot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_document_storageKey_key" ON "product_document"("storageKey");

-- CreateIndex
CREATE INDEX "product_document_productId_position_idx" ON "product_document"("productId", "position");

-- CreateIndex
CREATE INDEX "parts_diagram_mediaId_idx" ON "parts_diagram"("mediaId");

-- CreateIndex
CREATE INDEX "parts_diagram_product_productId_idx" ON "parts_diagram_product"("productId");

-- CreateIndex
CREATE INDEX "parts_diagram_hotspot_productId_idx" ON "parts_diagram_hotspot"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "parts_diagram_hotspot_diagramId_number_key" ON "parts_diagram_hotspot"("diagramId", "number");

-- AddForeignKey
ALTER TABLE "product_document" ADD CONSTRAINT "product_document_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_diagram" ADD CONSTRAINT "parts_diagram_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_diagram_product" ADD CONSTRAINT "parts_diagram_product_diagramId_fkey" FOREIGN KEY ("diagramId") REFERENCES "parts_diagram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_diagram_product" ADD CONSTRAINT "parts_diagram_product_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_diagram_hotspot" ADD CONSTRAINT "parts_diagram_hotspot_diagramId_fkey" FOREIGN KEY ("diagramId") REFERENCES "parts_diagram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts_diagram_hotspot" ADD CONSTRAINT "parts_diagram_hotspot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constrângeri scrise de mână (Prisma nu le poate exprima)
-- ---------------------------------------------------------------------------

ALTER TABLE "product"
  -- scara energetică: clasele vechi (A+++ … D) și cele noi (A … G)
  ADD CONSTRAINT "product_energyClass_check" CHECK (
    "energyClass" IS NULL
    OR "energyClass" IN ('A+++', 'A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G')
  ),
  -- doar adrese https (un link către EPREL ajunge pe pagina de produs)
  ADD CONSTRAINT "product_eprelUrl_check" CHECK ("eprelUrl" IS NULL OR "eprelUrl" ~ '^https://[^\s]+$');

-- Căutarea exactă după codul producătorului (fără diferență de majuscule)
CREATE INDEX "product_variant_manufacturerPartNumber_idx"
  ON "product_variant" (lower("manufacturerPartNumber")) WHERE "manufacturerPartNumber" IS NOT NULL;

ALTER TABLE "product_document"
  ADD CONSTRAINT "product_document_type_check" CHECK (
    "type" IN ('energy_label', 'product_sheet', 'manual', 'ce_declaration', 'datasheet', 'warranty', 'other')
  ),
  ADD CONSTRAINT "product_document_mime_check" CHECK (
    "mime" IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
  ),
  ADD CONSTRAINT "product_document_sizeBytes_check" CHECK ("sizeBytes" > 0),
  ADD CONSTRAINT "product_document_language_check" CHECK ("language" ~ '^[a-z]{2}$');

-- Fișa explodată: numere pozitive; poziția pe imagine (sutimi de procent) fie ambele coordonate, fie niciuna
ALTER TABLE "parts_diagram_hotspot"
  ADD CONSTRAINT "parts_diagram_hotspot_number_check" CHECK ("number" > 0),
  ADD CONSTRAINT "parts_diagram_hotspot_position_check" CHECK (
    ("xBp" IS NULL AND "yBp" IS NULL)
    OR ("xBp" IS NOT NULL AND "yBp" IS NOT NULL
        AND "xBp" BETWEEN 0 AND 10000 AND "yBp" BETWEEN 0 AND 10000)
  );
