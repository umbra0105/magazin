-- CreateTable
CREATE TABLE "brand" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "legacyId" TEXT,
    "legacyUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "excludeFromGroupDiscount" BOOLEAN NOT NULL DEFAULT false,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "legacyId" TEXT,
    "legacyUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "type" TEXT NOT NULL DEFAULT 'physical',
    "brandId" TEXT,
    "shippingClass" TEXT NOT NULL DEFAULT 'standard',
    "requiresInstallation" BOOLEAN NOT NULL DEFAULT false,
    "manageStock" BOOLEAN NOT NULL DEFAULT true,
    "stockStatus" TEXT NOT NULL DEFAULT 'instock',
    "excludeFromGroupDiscount" BOOLEAN NOT NULL DEFAULT false,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "publishedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "legacyId" TEXT,
    "legacyUrl" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_category" (
    "productId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_category_pkey" PRIMARY KEY ("productId","categoryId")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "ean" TEXT,
    "warrantyMonths" INTEGER,
    "price" INTEGER NOT NULL,
    "salePrice" INTEGER,
    "saleStartsAt" TIMESTAMP(3),
    "saleEndsAt" TIMESTAMP(3),
    "costPrice" INTEGER,
    "costPriceDate" TIMESTAMP(3),
    "weightGrams" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "manageStock" BOOLEAN,
    "stockStatus" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "legacyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_price_history" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "costPrice" INTEGER NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "importId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brand_slug_key" ON "brand"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "brand_legacyId_key" ON "brand"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "category_path_key" ON "category"("path");

-- CreateIndex
CREATE UNIQUE INDEX "category_legacyId_key" ON "category"("legacyId");

-- CreateIndex
CREATE INDEX "category_parentId_idx" ON "category"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "product_legacyId_key" ON "product"("legacyId");

-- CreateIndex
CREATE INDEX "product_brandId_idx" ON "product"("brandId");

-- CreateIndex
CREATE INDEX "product_status_idx" ON "product"("status");

-- CreateIndex
CREATE INDEX "product_deletedAt_idx" ON "product"("deletedAt");

-- CreateIndex
CREATE INDEX "product_category_categoryId_idx" ON "product_category"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_sku_key" ON "product_variant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_legacyId_key" ON "product_variant"("legacyId");

-- CreateIndex
CREATE INDEX "product_variant_productId_idx" ON "product_variant"("productId");

-- CreateIndex
CREATE INDEX "product_variant_ean_idx" ON "product_variant"("ean");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_id_productId_key" ON "product_variant"("id", "productId");

-- CreateIndex
CREATE INDEX "cost_price_history_variantId_effectiveDate_idx" ON "cost_price_history"("variantId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "price_history_variantId_effectiveFrom_key" ON "price_history"("variantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "product_media_productId_position_idx" ON "product_media"("productId", "position");

-- CreateIndex
CREATE INDEX "product_media_variantId_idx" ON "product_media"("variantId");

-- CreateIndex
CREATE INDEX "product_media_mediaId_idx" ON "product_media"("mediaId");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_price_history" ADD CONSTRAINT "cost_price_history_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variant"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constrângeri scrise de mână (Prisma nu le poate exprima)
-- ---------------------------------------------------------------------------

-- Valorile permise (aceleași seturi ca în tipurile din @ecom/core/catalog)
ALTER TABLE "product"
  ADD CONSTRAINT "product_status_check" CHECK ("status" IN ('draft', 'active', 'archived')),
  ADD CONSTRAINT "product_type_check" CHECK ("type" IN ('physical', 'digital')),
  ADD CONSTRAINT "product_shippingClass_check" CHECK ("shippingClass" IN ('standard', 'oversized', 'pallet')),
  ADD CONSTRAINT "product_stockStatus_check" CHECK ("stockStatus" IN ('instock', 'outofstock', 'onbackorder'));

ALTER TABLE "product_variant"
  ADD CONSTRAINT "product_variant_stockStatus_check"
    CHECK ("stockStatus" IS NULL OR "stockStatus" IN ('instock', 'outofstock', 'onbackorder')),
  -- sume în bani: întregi nenegative; promoția nu poate depăși prețul de listă
  ADD CONSTRAINT "product_variant_price_check" CHECK ("price" >= 0),
  ADD CONSTRAINT "product_variant_salePrice_check"
    CHECK ("salePrice" IS NULL OR ("salePrice" >= 0 AND "salePrice" <= "price")),
  ADD CONSTRAINT "product_variant_saleWindow_check"
    CHECK ("saleStartsAt" IS NULL OR "saleEndsAt" IS NULL OR "saleStartsAt" <= "saleEndsAt"),
  ADD CONSTRAINT "product_variant_costPrice_check" CHECK ("costPrice" IS NULL OR "costPrice" >= 0),
  ADD CONSTRAINT "product_variant_warrantyMonths_check"
    CHECK ("warrantyMonths" IS NULL OR "warrantyMonths" >= 0),
  -- GTIN-8/12/13/14: doar cifre, 8-14
  ADD CONSTRAINT "product_variant_ean_check" CHECK ("ean" IS NULL OR "ean" ~ '^[0-9]{8,14}$'),
  ADD CONSTRAINT "product_variant_dimensions_check" CHECK (
    ("weightGrams" IS NULL OR "weightGrams" > 0)
    AND ("lengthMm" IS NULL OR "lengthMm" > 0)
    AND ("widthMm" IS NULL OR "widthMm" > 0)
    AND ("heightMm" IS NULL OR "heightMm" > 0)
  );

ALTER TABLE "cost_price_history"
  ADD CONSTRAINT "cost_price_history_costPrice_check" CHECK ("costPrice" >= 0),
  ADD CONSTRAINT "cost_price_history_source_check" CHECK ("source" IN ('manual', 'import'));

ALTER TABLE "price_history"
  ADD CONSTRAINT "price_history_price_check" CHECK ("price" >= 0);

ALTER TABLE "category"
  ADD CONSTRAINT "category_depth_check" CHECK ("depth" >= 0);

-- Slug-ul produsului e unic printre produsele neșterse (după soft delete, adresa se poate refolosi).
CREATE UNIQUE INDEX "product_slug_active_key" ON "product" (lower("slug")) WHERE "deletedAt" IS NULL;

-- Slug-ul unei categorii e unic în același părinte (două indexuri: NULL nu intră în UNIQUE).
CREATE UNIQUE INDEX "category_slug_in_parent_key"
  ON "category" ("parentId", lower("slug")) WHERE "parentId" IS NOT NULL;
CREATE UNIQUE INDEX "category_slug_in_root_key"
  ON "category" (lower("slug")) WHERE "parentId" IS NULL;

-- Cel mult o categorie primară per produs.
CREATE UNIQUE INDEX "product_category_primary_key"
  ON "product_category" ("productId") WHERE "isPrimary";

-- Cel mult o variantă implicită per produs.
CREATE UNIQUE INDEX "product_variant_default_key"
  ON "product_variant" ("productId") WHERE "isDefault";

-- Aceeași imagine o singură dată pe produs (la nivel de produs) și o singură dată pe variantă.
CREATE UNIQUE INDEX "product_media_product_level_key"
  ON "product_media" ("productId", "mediaId") WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "product_media_variant_level_key"
  ON "product_media" ("variantId", "mediaId") WHERE "variantId" IS NOT NULL;
