-- AlterTable
ALTER TABLE "brand" ADD COLUMN     "logoMediaId" TEXT;

-- AlterTable
ALTER TABLE "category" ADD COLUMN     "imageMediaId" TEXT;

-- CreateIndex
CREATE INDEX "brand_logoMediaId_idx" ON "brand"("logoMediaId");

-- CreateIndex
CREATE INDEX "category_imageMediaId_idx" ON "category"("imageMediaId");

-- AddForeignKey
ALTER TABLE "brand" ADD CONSTRAINT "brand_logoMediaId_fkey" FOREIGN KEY ("logoMediaId") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_imageMediaId_fkey" FOREIGN KEY ("imageMediaId") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Plasă de siguranță pentru adâncimea arborelui (limita reală e în serviciu: MAX_CATEGORY_DEPTH = 4)
ALTER TABLE "category"
  ADD CONSTRAINT "category_depth_max_check" CHECK ("depth" <= 10);
