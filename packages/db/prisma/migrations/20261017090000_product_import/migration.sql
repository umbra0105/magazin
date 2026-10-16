-- Import de produse (Faza 4, punctul 14a): starea unui import dintr-un fișier CSV/XLSX, de la încărcare
-- la aplicare. Fișierul stă privat în storage (cheie generată de server), nu în baza de date.

-- CreateTable
CREATE TABLE "product_import" (
    "id" TEXT NOT NULL,
    "createdById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "fileName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileHash" TEXT NOT NULL,
    "storageKey" TEXT,
    "delimiter" TEXT,
    "mapping" JSONB,
    "planHash" TEXT,
    "rowCount" INTEGER NOT NULL,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "report" JSONB,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_import_storageKey_key" ON "product_import"("storageKey");

-- CreateIndex
CREATE INDEX "product_import_createdById_idx" ON "product_import"("createdById");

-- CreateIndex
CREATE INDEX "product_import_expiresAt_idx" ON "product_import"("expiresAt");

-- AddForeignKey
ALTER TABLE "product_import" ADD CONSTRAINT "product_import_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Valorile permise (coloanele sunt TEXT, ca în restul catalogului). Fiecare CHECK privește o singură
-- coloană și tratează explicit NULL, ca un CHECK cu rezultat NULL să nu treacă din greșeală.
ALTER TABLE "product_import"
  ADD CONSTRAINT "product_import_status_check"
    CHECK ("status" IN ('uploaded', 'validated', 'queued', 'running', 'completed', 'failed')),
  ADD CONSTRAINT "product_import_format_check" CHECK ("format" IN ('csv', 'xlsx')),
  ADD CONSTRAINT "product_import_sizeBytes_check" CHECK ("sizeBytes" > 0),
  ADD CONSTRAINT "product_import_rowCount_check" CHECK ("rowCount" > 0),
  ADD CONSTRAINT "product_import_processedRows_check"
    CHECK ("processedRows" >= 0 AND "processedRows" <= "rowCount"),
  ADD CONSTRAINT "product_import_delimiter_check"
    CHECK ("delimiter" IS NULL OR "delimiter" IN (',', ';', E'\t'));
