-- Faza 15: IMPORTUL PREȚURILOR DE ACHIZIȚIE (NIR). Migrare ADITIVĂ (fără DROP/TRUNCATE/DELETE): o tabelă nouă, `nir_import`, cu
-- previzualizarea, planul, raportul și starea fiecărui import. Nu atinge nicio tabelă existentă.


-- CreateTable
CREATE TABLE "nir_import" (
    "id" TEXT NOT NULL,
    "createdById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'previewed',
    "fileName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "plan" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nir_import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nir_import_createdById_idx" ON "nir_import"("createdById");

-- CreateIndex
CREATE INDEX "nir_import_status_idx" ON "nir_import"("status");

-- CreateIndex
CREATE INDEX "nir_import_createdAt_idx" ON "nir_import"("createdAt");

-- AddForeignKey
ALTER TABLE "nir_import" ADD CONSTRAINT "nir_import_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Constrângeri (comparații explicite IS NULL / IS NOT NULL; un CHECK cu rezultat NULL TRECE) ───
ALTER TABLE "nir_import" ADD CONSTRAINT "nir_import_status_check" CHECK (
  "status" IN ('previewed', 'queued', 'running', 'completed', 'failed')
);
ALTER TABLE "nir_import" ADD CONSTRAINT "nir_import_format_check" CHECK ("format" IN ('csv', 'xls', 'xlsx'));
ALTER TABLE "nir_import" ADD CONSTRAINT "nir_import_counts_check" CHECK (
  "sizeBytes" >= 0 AND "rowCount" >= 0 AND "itemCount" >= 0
  AND "processedItems" >= 0 AND "processedItems" <= "itemCount"
);
ALTER TABLE "nir_import" ADD CONSTRAINT "nir_import_file_check" CHECK (
  length("fileHash") = 64 AND length(btrim("fileName")) > 0
);
-- Ciclul de viață: previzualizat (nimic pornit), în coadă (neîncheiat), în lucru (pornit, neîncheiat), încheiat (pornit și încheiat),
-- eșuat (încheiat; poate să nu fi pornit niciodată).
ALTER TABLE "nir_import" ADD CONSTRAINT "nir_import_lifecycle_check" CHECK (
  ("status" = 'previewed' AND "startedAt" IS NULL AND "finishedAt" IS NULL)
  OR ("status" = 'queued' AND "finishedAt" IS NULL)
  OR ("status" = 'running' AND "startedAt" IS NOT NULL AND "finishedAt" IS NULL)
  OR ("status" = 'completed' AND "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL)
  OR ("status" = 'failed' AND "finishedAt" IS NOT NULL)
);
