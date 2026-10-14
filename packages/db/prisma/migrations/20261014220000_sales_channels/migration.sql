-- CreateTable
CREATE TABLE "sales_channel" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "requiresEan" BOOLEAN NOT NULL DEFAULT false,
    "requiresBrand" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_listing" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "externalId" TEXT,
    "externalProductKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "price" INTEGER,
    "salePrice" INTEGER,
    "stock" INTEGER,
    "validationErrors" JSONB NOT NULL DEFAULT '[]',
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_category_mapping" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "externalCategoryId" TEXT NOT NULL,
    "characteristicsMap" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_category_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_channel_code_key" ON "sales_channel"("code");

-- CreateIndex
CREATE INDEX "channel_listing_productId_idx" ON "channel_listing"("productId");

-- CreateIndex
CREATE INDEX "channel_listing_channelId_status_idx" ON "channel_listing"("channelId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_listing_channelId_variantId_key" ON "channel_listing"("channelId", "variantId");

-- CreateIndex
CREATE INDEX "channel_category_mapping_categoryId_idx" ON "channel_category_mapping"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_category_mapping_channelId_categoryId_key" ON "channel_category_mapping"("channelId", "categoryId");

-- AddForeignKey
ALTER TABLE "channel_listing" ADD CONSTRAINT "channel_listing_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_listing" ADD CONSTRAINT "channel_listing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_listing" ADD CONSTRAINT "channel_listing_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variant"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_category_mapping" ADD CONSTRAINT "channel_category_mapping_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_category_mapping" ADD CONSTRAINT "channel_category_mapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "category"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constrângeri scrise de mână (Prisma nu le poate exprima)
-- ---------------------------------------------------------------------------
-- Regulă: un CHECK compus folosește comparații explicite (IS NULL / IS NOT NULL) pe fiecare coloană;
-- NULL într-o comparație dă NULL, iar un CHECK cu rezultat NULL TRECE.

ALTER TABLE "sales_channel"
  ADD CONSTRAINT "sales_channel_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*$');

-- Canalul de sistem (`web`) nu se șterge
CREATE FUNCTION sales_channel_protect_system() RETURNS trigger AS $$
BEGIN
  IF OLD."isSystem" THEN
    RAISE EXCEPTION 'sales_channel_system_protected: canalul de sistem % nu se poate șterge', OLD."code"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sales_channel_protect_system_trg"
  BEFORE DELETE ON "sales_channel"
  FOR EACH ROW EXECUTE FUNCTION sales_channel_protect_system();

ALTER TABLE "channel_listing"
  ADD CONSTRAINT "channel_listing_status_check"
    CHECK ("status" IN ('draft', 'pending', 'active', 'rejected', 'inactive')),
  ADD CONSTRAINT "channel_listing_lastSyncStatus_check"
    CHECK ("lastSyncStatus" IS NULL OR "lastSyncStatus" IN ('ok', 'error')),
  ADD CONSTRAINT "channel_listing_price_check" CHECK ("price" IS NULL OR "price" >= 0),
  ADD CONSTRAINT "channel_listing_stock_check" CHECK ("stock" IS NULL OR "stock" >= 0),
  -- promoția pe canal cere prețul canalului și nu îl depășește (comparații explicite pe NULL)
  ADD CONSTRAINT "channel_listing_salePrice_check" CHECK (
    "salePrice" IS NULL
    OR ("price" IS NOT NULL AND "salePrice" >= 0 AND "salePrice" <= "price")
  );

-- Aceeași ofertă externă o singură dată pe canal
CREATE UNIQUE INDEX "channel_listing_external_key"
  ON "channel_listing" ("channelId", "externalId") WHERE "externalId" IS NOT NULL;
