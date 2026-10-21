-- Faza 5, punctul 1: schema stocului (unități de măsură, depozite, stoc, mișcări, rezervări, angajări, alerte).
-- AlterTable
ALTER TABLE "brand" ADD COLUMN     "defaultLeadTimeDays" INTEGER;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "leadTimeDays" INTEGER,
ADD COLUMN     "measureUnitId" TEXT,
ADD COLUMN     "minSteps" INTEGER,
ADD COLUMN     "priceBasis" TEXT NOT NULL DEFAULT 'unit',
ADD COLUMN     "saleStep" INTEGER,
ADD COLUMN     "showStepPrice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "product_variant" ADD COLUMN     "measureUnitId" TEXT,
ADD COLUMN     "minSteps" INTEGER,
ADD COLUMN     "priceBasis" TEXT,
ADD COLUMN     "saleStep" INTEGER,
ADD COLUMN     "smartbillMode" TEXT,
ADD COLUMN     "smartbillRatio" INTEGER,
ADD COLUMN     "smartbillUnitName" TEXT;

-- CreateTable
CREATE TABLE "measure_unit" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "smartbillName" TEXT,
    "decimals" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measure_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "physical" BIGINT NOT NULL DEFAULT 0,
    "physicalAsOf" TIMESTAMP(3),
    "committed" BIGINT NOT NULL DEFAULT 0,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "safetyBuffer" BIGINT NOT NULL DEFAULT 0,
    "lowStockSteps" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_snapshot" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT,
    "fileHash" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "report" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "deltaPhysical" BIGINT NOT NULL DEFAULT 0,
    "deltaCommitted" BIGINT NOT NULL DEFAULT 0,
    "physicalAfter" BIGINT NOT NULL,
    "committedAfter" BIGINT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refType" TEXT,
    "refId" TEXT,
    "snapshotId" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservation" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_commitment" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoicedAt" TIMESTAMP(3),
    "mirroredAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_commitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "back_in_stock_alert" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "back_in_stock_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "measure_unit_code_key" ON "measure_unit"("code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_code_key" ON "warehouse"("code");

-- CreateIndex
CREATE INDEX "inventory_item_warehouseId_idx" ON "inventory_item"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_variantId_warehouseId_key" ON "inventory_item"("variantId", "warehouseId");

-- CreateIndex
CREATE INDEX "stock_snapshot_warehouseId_takenAt_idx" ON "stock_snapshot"("warehouseId", "takenAt");

-- CreateIndex
CREATE INDEX "stock_movement_variantId_effectiveAt_idx" ON "stock_movement"("variantId", "effectiveAt");

-- CreateIndex
CREATE INDEX "stock_movement_warehouseId_effectiveAt_idx" ON "stock_movement"("warehouseId", "effectiveAt");

-- CreateIndex
CREATE INDEX "stock_movement_refType_refId_idx" ON "stock_movement"("refType", "refId");

-- CreateIndex
CREATE INDEX "stock_movement_snapshotId_idx" ON "stock_movement"("snapshotId");

-- CreateIndex
CREATE INDEX "stock_reservation_status_expiresAt_idx" ON "stock_reservation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "stock_reservation_variantId_warehouseId_status_idx" ON "stock_reservation"("variantId", "warehouseId", "status");

-- CreateIndex
CREATE INDEX "stock_reservation_refType_refId_idx" ON "stock_reservation"("refType", "refId");

-- CreateIndex
CREATE INDEX "stock_commitment_variantId_warehouseId_status_idx" ON "stock_commitment"("variantId", "warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_commitment_ref_key" ON "stock_commitment"("refType", "refId", "variantId", "warehouseId");

-- CreateIndex
CREATE INDEX "back_in_stock_alert_variantId_notifiedAt_idx" ON "back_in_stock_alert"("variantId", "notifiedAt");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_measureUnitId_fkey" FOREIGN KEY ("measureUnitId") REFERENCES "measure_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_measureUnitId_fkey" FOREIGN KEY ("measureUnitId") REFERENCES "measure_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item" ADD CONSTRAINT "inventory_item_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_snapshot" ADD CONSTRAINT "stock_snapshot_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "stock_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_variantId_warehouseId_fkey" FOREIGN KEY ("variantId", "warehouseId") REFERENCES "inventory_item"("variantId", "warehouseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_commitment" ADD CONSTRAINT "stock_commitment_variantId_warehouseId_fkey" FOREIGN KEY ("variantId", "warehouseId") REFERENCES "inventory_item"("variantId", "warehouseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "back_in_stock_alert" ADD CONSTRAINT "back_in_stock_alert_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Constrângeri scrise de mână (Prisma nu le exprimă).
-- Regulă: un CHECK compus folosește comparații explicite (IS NULL / IS NOT NULL) pe fiecare coloană;
-- NULL într-o comparație dă NULL, iar un CHECK cu rezultat NULL TRECE.
-- Plafonul cantităților de stoc: 1.000.000.000.000 zecimi de miime (= 100.000.000 de unități).
-- ===========================================================================

-- Unități de măsură
ALTER TABLE "measure_unit"
  ADD CONSTRAINT "measure_unit_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "measure_unit_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "measure_unit_symbol_check" CHECK (btrim("symbol") <> ''),
  ADD CONSTRAINT "measure_unit_smartbillName_check"
    CHECK ("smartbillName" IS NULL OR btrim("smartbillName") <> ''),
  ADD CONSTRAINT "measure_unit_decimals_check" CHECK ("decimals" >= 0 AND "decimals" <= 4);

CREATE FUNCTION measure_unit_protect_system() RETURNS trigger AS $$
BEGIN
  IF OLD."isSystem" THEN
    RAISE EXCEPTION 'measure_unit_system_protected: unitatea de sistem % nu se poate sterge', OLD."code"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "measure_unit_protect_system_trg"
  BEFORE DELETE ON "measure_unit"
  FOR EACH ROW EXECUTE FUNCTION measure_unit_protect_system();

-- Depozite: exact unul implicit, activ, care nu se șterge
ALTER TABLE "warehouse"
  ADD CONSTRAINT "warehouse_code_check" CHECK ("code" ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "warehouse_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "warehouse_default_active_check" CHECK ("isDefault" = false OR "isActive" = true);

CREATE UNIQUE INDEX "warehouse_single_default" ON "warehouse"("isDefault") WHERE "isDefault";

CREATE FUNCTION warehouse_protect_default() RETURNS trigger AS $$
BEGIN
  IF OLD."isDefault" THEN
    RAISE EXCEPTION 'warehouse_default_protected: depozitul implicit % nu se poate sterge', OLD."code"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "warehouse_protect_default_trg"
  BEFORE DELETE ON "warehouse"
  FOR EACH ROW EXECUTE FUNCTION warehouse_protect_default();

-- Unitate, bază de preț, pas și minim; termene de livrare
ALTER TABLE "product"
  ADD CONSTRAINT "product_priceBasis_check" CHECK ("priceBasis" IN ('unit', 'step')),
  ADD CONSTRAINT "product_saleStep_check" CHECK ("saleStep" IS NULL OR "saleStep" > 0),
  ADD CONSTRAINT "product_minSteps_check"
    CHECK ("minSteps" IS NULL OR ("minSteps" >= 1 AND "minSteps" <= 1000000)),
  ADD CONSTRAINT "product_leadTimeDays_check"
    CHECK ("leadTimeDays" IS NULL OR ("leadTimeDays" >= 0 AND "leadTimeDays" <= 365));

ALTER TABLE "product_variant"
  ADD CONSTRAINT "product_variant_priceBasis_check"
    CHECK ("priceBasis" IS NULL OR "priceBasis" IN ('unit', 'step')),
  ADD CONSTRAINT "product_variant_saleStep_check" CHECK ("saleStep" IS NULL OR "saleStep" > 0),
  ADD CONSTRAINT "product_variant_minSteps_check"
    CHECK ("minSteps" IS NULL OR ("minSteps" >= 1 AND "minSteps" <= 1000000)),
  ADD CONSTRAINT "product_variant_smartbill_check" CHECK (
    ("smartbillMode" IS NULL AND "smartbillRatio" IS NULL)
    OR ("smartbillMode" IS NOT NULL AND "smartbillMode" IN ('same_unit', 'steps') AND "smartbillRatio" IS NULL)
    OR ("smartbillMode" IS NOT NULL AND "smartbillMode" = 'ratio' AND "smartbillRatio" IS NOT NULL AND "smartbillRatio" > 0)
  ),
  ADD CONSTRAINT "product_variant_smartbillUnitName_check"
    CHECK ("smartbillUnitName" IS NULL OR btrim("smartbillUnitName") <> '');

ALTER TABLE "brand"
  ADD CONSTRAINT "brand_defaultLeadTimeDays_check"
    CHECK ("defaultLeadTimeDays" IS NULL OR ("defaultLeadTimeDays" >= 0 AND "defaultLeadTimeDays" <= 365));

-- Stocul: fără cantități negative (D5), fără depășirea plafonului
ALTER TABLE "inventory_item"
  ADD CONSTRAINT "inventory_item_physical_check" CHECK ("physical" >= 0 AND "physical" <= 1000000000000),
  ADD CONSTRAINT "inventory_item_committed_check" CHECK ("committed" >= 0 AND "committed" <= 1000000000000),
  ADD CONSTRAINT "inventory_item_reserved_check" CHECK ("reserved" >= 0 AND "reserved" <= 1000000000000),
  ADD CONSTRAINT "inventory_item_safetyBuffer_check" CHECK ("safetyBuffer" >= 0 AND "safetyBuffer" <= 1000000000000),
  ADD CONSTRAINT "inventory_item_lowStockSteps_check" CHECK ("lowStockSteps" IS NULL OR "lowStockSteps" >= 0);

ALTER TABLE "stock_snapshot"
  ADD CONSTRAINT "stock_snapshot_source_check" CHECK ("source" IN ('import', 'api')),
  ADD CONSTRAINT "stock_snapshot_rowCount_check" CHECK ("rowCount" >= 0);

-- Registrul de mișcări
ALTER TABLE "stock_movement"
  ADD CONSTRAINT "stock_movement_kind_check" CHECK (
    "kind" IN ('adjustment', 'snapshot', 'commit', 'release', 'mirror', 'transfer_in', 'transfer_out')
  ),
  ADD CONSTRAINT "stock_movement_reason_check" CHECK (
    "reason" IS NULL OR "reason" IN (
      'sale_in_store', 'receipt', 'return', 'inventory_correction', 'damaged', 'lost_stolen', 'other'
    )
  ),
  -- ajustarea cere motiv fix ȘI text liber nevid
  ADD CONSTRAINT "stock_movement_adjustment_check" CHECK (
    "kind" <> 'adjustment'
    OR ("reason" IS NOT NULL AND "note" IS NOT NULL AND btrim("note") <> '')
  ),
  -- referința generică: tip și id împreună sau deloc
  ADD CONSTRAINT "stock_movement_ref_check" CHECK (
    ("refType" IS NULL AND "refId" IS NULL)
    OR ("refType" IS NOT NULL AND "refId" IS NOT NULL AND "refType" ~ '^[a-z][a-z0-9_]*$' AND btrim("refId") <> '')
  ),
  -- mișcarea unei poze trimite la poză; celelalte nu
  ADD CONSTRAINT "stock_movement_snapshot_check" CHECK (
    ("kind" = 'snapshot' AND "snapshotId" IS NOT NULL)
    OR ("kind" <> 'snapshot' AND "snapshotId" IS NULL)
  ),
  ADD CONSTRAINT "stock_movement_nonzero_check" CHECK ("deltaPhysical" <> 0 OR "deltaCommitted" <> 0),
  ADD CONSTRAINT "stock_movement_delta_check" CHECK (
    abs("deltaPhysical") <= 1000000000000 AND abs("deltaCommitted") <= 1000000000000
  ),
  ADD CONSTRAINT "stock_movement_physicalAfter_check" CHECK ("physicalAfter" >= 0 AND "physicalAfter" <= 1000000000000),
  ADD CONSTRAINT "stock_movement_committedAfter_check" CHECK ("committedAfter" >= 0 AND "committedAfter" <= 1000000000000);

-- Registru DOAR DE ADĂUGARE: orice UPDATE, DELETE sau TRUNCATE este respins de baza de date.
CREATE FUNCTION stock_movement_reject_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movement este doar de adaugare: % interzis', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER stock_movement_no_update_delete
  BEFORE UPDATE OR DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_reject_changes();

CREATE TRIGGER stock_movement_no_truncate
  BEFORE TRUNCATE ON "stock_movement"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movement_reject_changes();

-- Rezervări: o singură rezervare activă sau confirmată per referință și linie
ALTER TABLE "stock_reservation"
  ADD CONSTRAINT "stock_reservation_quantity_check" CHECK ("quantity" > 0 AND "quantity" <= 1000000000000),
  ADD CONSTRAINT "stock_reservation_status_check" CHECK (
    ("status" = 'active' AND "confirmedAt" IS NULL AND "releasedAt" IS NULL)
    OR ("status" = 'confirmed' AND "confirmedAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR ("status" IN ('released', 'expired') AND "confirmedAt" IS NULL AND "releasedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "stock_reservation_ref_check" CHECK (
    "refType" ~ '^[a-z][a-z0-9_]*$' AND btrim("refId") <> ''
  );

CREATE UNIQUE INDEX "stock_reservation_ref_open_key"
  ON "stock_reservation"("refType", "refId", "variantId", "warehouseId")
  WHERE "status" IN ('active', 'confirmed');

-- Angajări (D1): unice per comandă și linie, chiar și după eliberare
ALTER TABLE "stock_commitment"
  ADD CONSTRAINT "stock_commitment_quantity_check" CHECK ("quantity" > 0 AND "quantity" <= 1000000000000),
  ADD CONSTRAINT "stock_commitment_status_check" CHECK (
    ("status" = 'open' AND "mirroredAt" IS NULL AND "releasedAt" IS NULL)
    OR ("status" = 'mirrored' AND "mirroredAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR ("status" = 'released' AND "mirroredAt" IS NULL AND "releasedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "stock_commitment_ref_check" CHECK (
    "refType" ~ '^[a-z][a-z0-9_]*$' AND btrim("refId") <> ''
  );

-- „Anunță-mă când revine”: o cerere în așteptare per variantă și adresă
ALTER TABLE "back_in_stock_alert"
  ADD CONSTRAINT "back_in_stock_alert_email_check" CHECK (length("email") <= 254 AND position('@' in "email") > 1);

CREATE UNIQUE INDEX "back_in_stock_alert_pending_key"
  ON "back_in_stock_alert"("variantId", lower("email"))
  WHERE "notifiedAt" IS NULL;

-- ===========================================================================
-- Migrare de date (D2): inventarul îl face utilizatorul, deci produsele și variantele EXISTENTE, care nu au
-- niciun rând de stoc, trec pe „negestionat” (rămân „în stoc”, fără cantitate). Produsele create după
-- migrare păstrează valoarea implicită (setarea `inventory.manageStock`, implicit ON). Nu schimbă `updatedAt`.
-- ===========================================================================
UPDATE "product" p
SET "manageStock" = false
WHERE p."manageStock" = true
  AND NOT EXISTS (
    SELECT 1 FROM "product_variant" v
    JOIN "inventory_item" i ON i."variantId" = v."id"
    WHERE v."productId" = p."id"
  );

UPDATE "product_variant" v
SET "manageStock" = false
WHERE v."manageStock" IS TRUE
  AND NOT EXISTS (SELECT 1 FROM "inventory_item" i WHERE i."variantId" = v."id");
