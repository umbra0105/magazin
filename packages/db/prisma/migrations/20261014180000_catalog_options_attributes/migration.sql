-- AlterTable
ALTER TABLE "product" ADD COLUMN     "taxClassId" TEXT;

-- CreateTable
CREATE TABLE "product_option" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_value" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "option_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_option_value" (
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,

    CONSTRAINT "variant_option_value_pkey" PRIMARY KEY ("variantId","optionId")
);

-- CreateTable
CREATE TABLE "collection" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'manual',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "legacyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_product" (
    "collectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "collection_product_pkey" PRIMARY KEY ("collectionId","productId")
);

-- CreateTable
CREATE TABLE "attribute" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "unit" TEXT,
    "isFilterable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_option" (
    "id" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attribute_option_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_value" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "textValue" TEXT,
    "numberValue" DECIMAL(18,4),
    "boolValue" BOOLEAN,
    "optionId" TEXT,

    CONSTRAINT "attribute_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_relation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "relatedProductId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_relation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_class" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" TEXT NOT NULL,
    "taxClassId" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_option_productId_position_idx" ON "product_option"("productId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_id_productId_key" ON "product_option"("id", "productId");

-- CreateIndex
CREATE INDEX "option_value_optionId_position_idx" ON "option_value"("optionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "option_value_id_optionId_key" ON "option_value"("id", "optionId");

-- CreateIndex
CREATE INDEX "variant_option_value_optionValueId_idx" ON "variant_option_value"("optionValueId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_legacyId_key" ON "collection"("legacyId");

-- CreateIndex
CREATE INDEX "collection_product_productId_idx" ON "collection_product"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_code_key" ON "attribute"("code");

-- CreateIndex
CREATE INDEX "attribute_option_attributeId_position_idx" ON "attribute_option"("attributeId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_option_id_attributeId_key" ON "attribute_option"("id", "attributeId");

-- CreateIndex
CREATE INDEX "attribute_value_attributeId_numberValue_idx" ON "attribute_value"("attributeId", "numberValue");

-- CreateIndex
CREATE INDEX "attribute_value_attributeId_optionId_idx" ON "attribute_value"("attributeId", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_value_productId_attributeId_key" ON "attribute_value"("productId", "attributeId");

-- CreateIndex
CREATE INDEX "product_relation_relatedProductId_idx" ON "product_relation"("relatedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "product_relation_productId_relatedProductId_type_key" ON "product_relation"("productId", "relatedProductId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "tax_class_code_key" ON "tax_class"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_taxClassId_validFrom_key" ON "tax_rate"("taxClassId", "validFrom");

-- CreateIndex
CREATE INDEX "product_taxClassId_idx" ON "product"("taxClassId");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_taxClassId_fkey" FOREIGN KEY ("taxClassId") REFERENCES "tax_class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option" ADD CONSTRAINT "product_option_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_value" ADD CONSTRAINT "option_value_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "product_option"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_value" ADD CONSTRAINT "variant_option_value_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variant"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_value" ADD CONSTRAINT "variant_option_value_optionId_productId_fkey" FOREIGN KEY ("optionId", "productId") REFERENCES "product_option"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_value" ADD CONSTRAINT "variant_option_value_optionValueId_optionId_fkey" FOREIGN KEY ("optionValueId", "optionId") REFERENCES "option_value"("id", "optionId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_product" ADD CONSTRAINT "collection_product_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_product" ADD CONSTRAINT "collection_product_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_option" ADD CONSTRAINT "attribute_option_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "attribute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_value" ADD CONSTRAINT "attribute_value_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_value" ADD CONSTRAINT "attribute_value_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "attribute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_value" ADD CONSTRAINT "attribute_value_optionId_attributeId_fkey" FOREIGN KEY ("optionId", "attributeId") REFERENCES "attribute_option"("id", "attributeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_relation" ADD CONSTRAINT "product_relation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_relation" ADD CONSTRAINT "product_relation_relatedProductId_fkey" FOREIGN KEY ("relatedProductId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_taxClassId_fkey" FOREIGN KEY ("taxClassId") REFERENCES "tax_class"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constrângeri scrise de mână (Prisma nu le poate exprima)
-- ---------------------------------------------------------------------------

-- Opțiuni: nume unic per produs, valoare unică per opțiune (fără diferență de majuscule)
CREATE UNIQUE INDEX "product_option_name_key" ON "product_option" ("productId", lower("name"));
CREATE UNIQUE INDEX "option_value_value_key" ON "option_value" ("optionId", lower("value"));

-- Colecții
ALTER TABLE "collection"
  ADD CONSTRAINT "collection_type_check" CHECK ("type" IN ('manual', 'automated'));
CREATE UNIQUE INDEX "collection_slug_key" ON "collection" (lower("slug"));

-- Atribute: cod stabil (litere mici, cifre, _), tip permis, unitate doar la numerice
ALTER TABLE "attribute"
  ADD CONSTRAINT "attribute_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "attribute_type_check" CHECK ("type" IN ('text', 'number', 'select', 'bool')),
  ADD CONSTRAINT "attribute_unit_check" CHECK ("unit" IS NULL OR "type" = 'number');

CREATE UNIQUE INDEX "attribute_option_value_key" ON "attribute_option" ("attributeId", lower("value"));

-- Valoarea unui atribut: exact o coloană setată...
ALTER TABLE "attribute_value"
  ADD CONSTRAINT "attribute_value_one_value_check"
    CHECK (num_nonnulls("textValue", "numberValue", "boolValue", "optionId") = 1);

-- ...și potrivită cu tipul atributului (CHECK-ul nu poate privi alt tabel, deci trigger).
CREATE FUNCTION attribute_value_matches_type() RETURNS trigger AS $$
DECLARE
  attr_type text;
BEGIN
  SELECT "type" INTO attr_type FROM "attribute" WHERE "id" = NEW."attributeId";
  IF attr_type = 'text' AND NEW."textValue" IS NULL
    OR attr_type = 'number' AND NEW."numberValue" IS NULL
    OR attr_type = 'bool' AND NEW."boolValue" IS NULL
    OR attr_type = 'select' AND NEW."optionId" IS NULL THEN
    RAISE EXCEPTION 'attribute_value_type_mismatch: atributul % are tipul %', NEW."attributeId", attr_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attribute_value_matches_type_trg"
  BEFORE INSERT OR UPDATE ON "attribute_value"
  FOR EACH ROW EXECUTE FUNCTION attribute_value_matches_type();

-- Relații între produse: tipuri permise, fără auto-relație
ALTER TABLE "product_relation"
  ADD CONSTRAINT "product_relation_type_check" CHECK (
    "type" IN ('similar', 'accessory', 'upsell', 'crosssell', 'spare_part', 'compatible_with')
  ),
  ADD CONSTRAINT "product_relation_self_check" CHECK ("productId" <> "relatedProductId");

-- Taxare: cod stabil, cotă în puncte de bază între 0 și 100%, o singură clasă implicită
ALTER TABLE "tax_class"
  ADD CONSTRAINT "tax_class_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "tax_rate"
  ADD CONSTRAINT "tax_rate_rateBps_check" CHECK ("rateBps" >= 0 AND "rateBps" <= 10000);
CREATE UNIQUE INDEX "tax_class_default_key" ON "tax_class" ((true)) WHERE "isDefault";
