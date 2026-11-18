-- Checkout și comenzi (Faza 9). ADITIV: tabele noi (comenzi, linii, evenimente, plăți, adrese, zone și metode de livrare, contor,
-- nomenclator SIRUTA, excluderi de la transportul gratuit) și o singură coloană nouă, NULĂ, pe stock_reservation și
-- stock_commitment (cheia străină spre comandă). Nicio coloană, niciun rând existent nu se modifică sau se șterge.
--
-- Garda de mai jos oprește migrarea (fără nicio modificare) dacă în stoc există deja rânduri cu referința de tip «order»:
-- tabela comenzilor nu exista până acum, deci orice astfel de rând ar fi orfan, iar cheia străină nu s-ar putea pune.
-- Rândurile cu alt tip de referință rămân neatinse (orderId nul).

DO $$
DECLARE
  existing_reservations integer;
  existing_commitments integer;
BEGIN
  SELECT count(*) INTO existing_reservations FROM "stock_reservation" WHERE "refType" = 'order';
  SELECT count(*) INTO existing_commitments FROM "stock_commitment" WHERE "refType" = 'order';
  IF existing_reservations > 0 OR existing_commitments > 0 THEN
    RAISE EXCEPTION 'Migrare oprită: % rezervări și % angajări de stoc cu refType order există înaintea tabelei comenzilor (orfane). Nu s-a modificat nimic; verifică-le înainte de a continua.',
      existing_reservations, existing_commitments;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "stock_reservation" ADD COLUMN     "orderId" TEXT;

-- AlterTable
ALTER TABLE "stock_commitment" ADD COLUMN     "orderId" TEXT;

-- CreateTable
CREATE TABLE "siruta_unit" (
    "code" INTEGER NOT NULL,
    "countyCode" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "parentCode" INTEGER,
    "tip" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "siruta_unit_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "order_counter" (
    "id" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_order" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "externalId" TEXT,
    "externalData" JSONB,
    "parentSubscriptionId" TEXT,
    "customerId" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paymentStatus" TEXT NOT NULL DEFAULT 'pending',
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'unfulfilled',
    "subtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "shippingMinor" INTEGER NOT NULL,
    "codFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "shippingTaxMinor" INTEGER NOT NULL DEFAULT 0,
    "codFeeTaxMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL,
    "groupPricingType" TEXT NOT NULL DEFAULT 'none',
    "shippingMethodCode" TEXT NOT NULL,
    "shippingSnapshot" JSONB NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "customerNote" TEXT,
    "adminNote" TEXT,
    "installationRequested" BOOLEAN NOT NULL DEFAULT false,
    "installationNote" TEXT,
    "termsAcceptedAt" TIMESTAMP(3) NOT NULL,
    "termsConsentText" TEXT NOT NULL,
    "termsConsentVersion" TEXT NOT NULL,
    "reservationExpiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'web',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "imageUrl" TEXT,
    "quantity" BIGINT NOT NULL,
    "unitSymbol" TEXT NOT NULL,
    "unitDecimals" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "lineTotalMinor" INTEGER NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL,
    "stockState" TEXT NOT NULL,
    "leadTimeDays" INTEGER,
    "shippingClass" TEXT NOT NULL,
    "productSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_event" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerRef" TEXT,
    "idempotencyKey" TEXT,
    "rawPayload" JSONB,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "address" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "company" TEXT,
    "vatId" TEXT,
    "vatIdVerification" TEXT,
    "tradeRegisterNo" TEXT,
    "phone" TEXT NOT NULL,
    "countyCode" INTEGER NOT NULL,
    "countyName" TEXT NOT NULL,
    "localityCode" INTEGER NOT NULL,
    "localityName" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'RO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "countyCodes" INTEGER[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_method" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "carrier" TEXT,
    "type" TEXT NOT NULL,
    "priceMinor" INTEGER NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "freeAboveMinor" INTEGER,
    "codFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "estimatedDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_shipping_exclusion" (
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_shipping_exclusion_pkey" PRIMARY KEY ("productId")
);

-- CreateIndex
CREATE INDEX "siruta_unit_countyCode_level_idx" ON "siruta_unit"("countyCode", "level");

-- CreateIndex
CREATE INDEX "siruta_unit_parentCode_idx" ON "siruta_unit"("parentCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_number_key" ON "customer_order"("number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_idempotencyKey_key" ON "customer_order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_order_status_paymentStatus_idx" ON "customer_order"("status", "paymentStatus");

-- CreateIndex
CREATE INDEX "customer_order_email_idx" ON "customer_order"("email");

-- CreateIndex
CREATE INDEX "customer_order_reservationExpiresAt_idx" ON "customer_order"("reservationExpiresAt");

-- CreateIndex
CREATE INDEX "customer_order_channelId_idx" ON "customer_order"("channelId");

-- CreateIndex
CREATE INDEX "customer_order_placedAt_idx" ON "customer_order"("placedAt");

-- CreateIndex
CREATE INDEX "order_line_variantId_idx" ON "order_line"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_orderId_variantId_key" ON "order_line"("orderId", "variantId");

-- CreateIndex
CREATE INDEX "order_event_orderId_createdAt_idx" ON "order_event"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotencyKey_key" ON "payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_orderId_idx" ON "payment"("orderId");

-- CreateIndex
CREATE INDEX "address_countyCode_idx" ON "address"("countyCode");

-- CreateIndex
CREATE INDEX "address_localityCode_idx" ON "address"("localityCode");

-- CreateIndex
CREATE UNIQUE INDEX "address_orderId_kind_key" ON "address"("orderId", "kind");

-- CreateIndex
CREATE INDEX "shipping_method_zoneId_isActive_idx" ON "shipping_method"("zoneId", "isActive");

-- CreateIndex
CREATE INDEX "stock_reservation_orderId_idx" ON "stock_reservation"("orderId");

-- CreateIndex
CREATE INDEX "stock_commitment_orderId_idx" ON "stock_commitment"("orderId");

-- AddForeignKey
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_commitment" ADD CONSTRAINT "stock_commitment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "siruta_unit" ADD CONSTRAINT "siruta_unit_parentCode_fkey" FOREIGN KEY ("parentCode") REFERENCES "siruta_unit"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_countyCode_fkey" FOREIGN KEY ("countyCode") REFERENCES "siruta_unit"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_localityCode_fkey" FOREIGN KEY ("localityCode") REFERENCES "siruta_unit"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_method" ADD CONSTRAINT "shipping_method_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "shipping_zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_shipping_exclusion" ADD CONSTRAINT "free_shipping_exclusion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------------
-- Constrângeri (CHECK). Orice CHECK compus folosește comparații explicite (IS NULL / IS NOT NULL) pe fiecare coloană.

-- Cheia străină a stocului spre comandă: referința de tip «order» are orderId = refId; celelalte tipuri nu au orderId.
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_order_ref_check"
  CHECK (("refType" = 'order' AND "orderId" IS NOT NULL AND "orderId" = "refId")
      OR ("refType" <> 'order' AND "orderId" IS NULL));
ALTER TABLE "stock_commitment" ADD CONSTRAINT "stock_commitment_order_ref_check"
  CHECK (("refType" = 'order' AND "orderId" IS NOT NULL AND "orderId" = "refId")
      OR ("refType" <> 'order' AND "orderId" IS NULL));

-- Nomenclatorul SIRUTA: județul nu are părinte; UAT-ul și localitatea au.
ALTER TABLE "siruta_unit" ADD CONSTRAINT "siruta_unit_level_check"
  CHECK (("level" = 1 AND "parentCode" IS NULL) OR ("level" IN (2, 3) AND "parentCode" IS NOT NULL));

-- Contorul numerelor: un singur rând, valoare nenegativă.
ALTER TABLE "order_counter" ADD CONSTRAINT "order_counter_single_check" CHECK ("id" = 'order' AND "lastValue" >= 0);

-- Comanda: stări, sume și coerența lor.
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_status_check"
  CHECK ("status" IN ('draft', 'pending', 'confirmed', 'processing', 'completed', 'cancelled', 'returned'));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_payment_status_check"
  CHECK ("paymentStatus" IN ('pending', 'authorized', 'paid', 'partially_refunded', 'refunded', 'failed', 'cancelled', 'chargeback'));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_fulfillment_status_check"
  CHECK ("fulfillmentStatus" IN ('unfulfilled', 'partially_fulfilled', 'fulfilled', 'in_transit', 'delivered', 'returned', 'cancelled'));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_payment_method_check"
  CHECK ("paymentMethod" IN ('cod', 'bank_transfer'));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_source_check"
  CHECK ("source" IN ('web', 'admin', 'emag', 'api'));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_amounts_check"
  CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "shippingMinor" >= 0 AND "codFeeMinor" >= 0
     AND "taxMinor" >= 0 AND "totalMinor" > 0 AND "taxRateBps" >= 0 AND "taxRateBps" <= 10000);
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_tax_parts_check"
  CHECK ("shippingTaxMinor" >= 0 AND "shippingTaxMinor" <= "shippingMinor"
     AND "codFeeTaxMinor" >= 0 AND "codFeeTaxMinor" <= "codFeeMinor"
     AND "taxMinor" <= "totalMinor");
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_total_check"
  CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "shippingMinor" + "codFeeMinor");
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_cod_fee_check"
  CHECK ("paymentMethod" = 'cod' OR "codFeeMinor" = 0);
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_reservation_check"
  CHECK (("paymentMethod" = 'cod' AND "reservationExpiresAt" IS NULL)
      OR ("paymentMethod" = 'bank_transfer' AND "reservationExpiresAt" IS NOT NULL));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_cancelled_check"
  CHECK (("status" = 'cancelled' AND "cancelledAt" IS NOT NULL)
      OR ("status" <> 'cancelled' AND "cancelledAt" IS NULL));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_contact_check"
  CHECK (length(btrim("email")) > 0 AND length(btrim("phone")) > 0 AND length(btrim("termsConsentText")) > 0
     AND length(btrim("termsConsentVersion")) > 0);

-- Linia de comandă.
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_amounts_check"
  CHECK ("quantity" > 0 AND "unitPriceMinor" >= 0 AND "discountMinor" >= 0 AND "lineTotalMinor" >= 0
     AND "netMinor" >= 0 AND "taxMinor" >= 0 AND "taxRateBps" >= 0 AND "taxRateBps" <= 10000
     AND "unitDecimals" >= 0 AND "unitDecimals" <= 4);
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_total_check"
  CHECK ("netMinor" + "taxMinor" = "lineTotalMinor");
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_stock_state_check"
  CHECK (("stockState" = 'on_order' AND "leadTimeDays" IS NOT NULL AND "leadTimeDays" >= 0)
      OR ("stockState" IN ('in_stock', 'limited') AND "leadTimeDays" IS NULL));
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_shipping_class_check"
  CHECK ("shippingClass" IN ('standard', 'oversized', 'pallet'));

-- Plata.
ALTER TABLE "payment" ADD CONSTRAINT "payment_provider_check" CHECK ("provider" IN ('cod', 'bank_transfer'));
ALTER TABLE "payment" ADD CONSTRAINT "payment_status_check"
  CHECK ("status" IN ('pending', 'paid', 'failed', 'cancelled', 'refunded'));
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "payment" ADD CONSTRAINT "payment_captured_check"
  CHECK (("status" <> 'paid' AND "status" <> 'refunded') OR "capturedAt" IS NOT NULL);

-- Adresa: tip, cod poștal (6 cifre) și CUI cu starea verificării.
ALTER TABLE "address" ADD CONSTRAINT "address_kind_check" CHECK ("kind" IN ('shipping', 'billing'));
ALTER TABLE "address" ADD CONSTRAINT "address_postal_code_check" CHECK ("postalCode" ~ '^[0-9]{6}$');
ALTER TABLE "address" ADD CONSTRAINT "address_vat_check"
  CHECK (("vatId" IS NULL AND "vatIdVerification" IS NULL)
      OR ("vatId" IS NOT NULL AND "vatIdVerification" IS NOT NULL AND "vatIdVerification" IN ('verified', 'unverified')));

-- Livrare.
ALTER TABLE "shipping_zone" ADD CONSTRAINT "shipping_zone_counties_check" CHECK (cardinality("countyCodes") > 0);
ALTER TABLE "shipping_method" ADD CONSTRAINT "shipping_method_type_check" CHECK ("type" IN ('flat', 'weight', 'pickup'));
ALTER TABLE "shipping_method" ADD CONSTRAINT "shipping_method_amounts_check"
  CHECK ("priceMinor" >= 0 AND "codFeeMinor" >= 0
     AND ("freeAboveMinor" IS NULL OR "freeAboveMinor" > 0)
     AND ("estimatedDays" IS NULL OR "estimatedDays" >= 0));

-- ---------------------------------------------------------------------------------------------------------------------
-- Snapshot imuabil: sumele și instantaneul comenzii nu se modifică după plasare (doar stările, notele și momentele),
-- linia nu se modifică (excepție: variantId devine NULL când varianta e ștearsă definitiv), adresa nu se modifică deloc.
-- DELETE rămâne posibil (curățarea fixture-urilor; nicio cale din aplicație nu șterge comenzi).

CREATE FUNCTION "customer_order_immutable_fields"() RETURNS trigger AS $$
BEGIN
  IF NEW."number" IS DISTINCT FROM OLD."number"
    OR NEW."channelId" IS DISTINCT FROM OLD."channelId"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."subtotalMinor" IS DISTINCT FROM OLD."subtotalMinor"
    OR NEW."discountMinor" IS DISTINCT FROM OLD."discountMinor"
    OR NEW."shippingMinor" IS DISTINCT FROM OLD."shippingMinor"
    OR NEW."codFeeMinor" IS DISTINCT FROM OLD."codFeeMinor"
    OR NEW."shippingTaxMinor" IS DISTINCT FROM OLD."shippingTaxMinor"
    OR NEW."codFeeTaxMinor" IS DISTINCT FROM OLD."codFeeTaxMinor"
    OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor"
    OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
    OR NEW."taxRateBps" IS DISTINCT FROM OLD."taxRateBps"
    OR NEW."shippingMethodCode" IS DISTINCT FROM OLD."shippingMethodCode"
    OR NEW."shippingSnapshot"::text IS DISTINCT FROM OLD."shippingSnapshot"::text
    OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
    OR NEW."termsAcceptedAt" IS DISTINCT FROM OLD."termsAcceptedAt"
    OR NEW."termsConsentText" IS DISTINCT FROM OLD."termsConsentText"
    OR NEW."termsConsentVersion" IS DISTINCT FROM OLD."termsConsentVersion"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."placedAt" IS DISTINCT FROM OLD."placedAt" THEN
    RAISE EXCEPTION 'Comanda este un snapshot imuabil: sumele, metodele și consimțământul nu se modifică după plasare';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "customer_order_immutable_fields_trg" BEFORE UPDATE ON "customer_order"
  FOR EACH ROW EXECUTE FUNCTION "customer_order_immutable_fields"();

CREATE FUNCTION "order_line_immutable_fields"() RETURNS trigger AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."sku" IS DISTINCT FROM OLD."sku"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."variantTitle" IS DISTINCT FROM OLD."variantTitle"
    OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
    OR NEW."unitPriceMinor" IS DISTINCT FROM OLD."unitPriceMinor"
    OR NEW."discountMinor" IS DISTINCT FROM OLD."discountMinor"
    OR NEW."lineTotalMinor" IS DISTINCT FROM OLD."lineTotalMinor"
    OR NEW."netMinor" IS DISTINCT FROM OLD."netMinor"
    OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor"
    OR NEW."taxRateBps" IS DISTINCT FROM OLD."taxRateBps"
    OR NEW."stockState" IS DISTINCT FROM OLD."stockState"
    OR NEW."leadTimeDays" IS DISTINCT FROM OLD."leadTimeDays"
    OR NEW."shippingClass" IS DISTINCT FROM OLD."shippingClass"
    OR NEW."productSnapshot"::text IS DISTINCT FROM OLD."productSnapshot"::text THEN
    RAISE EXCEPTION 'Linia de comandă este un snapshot imuabil';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "order_line_immutable_fields_trg" BEFORE UPDATE ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION "order_line_immutable_fields"();

CREATE FUNCTION "address_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Adresa comenzii este un snapshot imuabil';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "address_immutable_trg" BEFORE UPDATE ON "address"
  FOR EACH ROW EXECUTE FUNCTION "address_immutable"();

-- ---------------------------------------------------------------------------------------------------------------------
-- Integritatea totalurilor, verificată la COMMIT (constrângeri amânate): subtotalul comenzii = suma totalurilor liniilor, iar
-- TVA-ul comenzii = suma TVA-urilor pe linii + TVA transport + TVA taxă de ramburs. O comandă fără linii nu se poate comite.
-- (Tranzacțiile anulate, ca cele ale testelor, nu declanșează verificarea.)

CREATE FUNCTION "order_totals_integrity"() RETURNS trigger AS $$
DECLARE
  oid text;
  ord record;
  lines_count integer;
  lines_total bigint;
  lines_tax bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    oid := OLD."orderId";
  ELSIF TG_TABLE_NAME = 'customer_order' THEN
    oid := NEW."id";
  ELSE
    oid := NEW."orderId";
  END IF;
  SELECT * INTO ord FROM "customer_order" WHERE "id" = oid;
  IF NOT FOUND THEN
    RETURN NULL; -- comanda a fost ștearsă în aceeași tranzacție
  END IF;
  SELECT count(*), COALESCE(sum("lineTotalMinor"), 0), COALESCE(sum("taxMinor"), 0)
    INTO lines_count, lines_total, lines_tax
    FROM "order_line" WHERE "orderId" = oid;
  IF lines_count = 0 THEN
    RAISE EXCEPTION 'Comanda % nu are nicio linie', ord."number";
  END IF;
  IF lines_total <> ord."subtotalMinor" THEN
    RAISE EXCEPTION 'Comanda %: subtotalul (%) nu e suma liniilor (%)', ord."number", ord."subtotalMinor", lines_total;
  END IF;
  IF lines_tax + ord."shippingTaxMinor" + ord."codFeeTaxMinor" <> ord."taxMinor" THEN
    RAISE EXCEPTION 'Comanda %: TVA-ul (%) nu e suma TVA-urilor pe linii (%) plus transport (%) și taxa de ramburs (%)',
      ord."number", ord."taxMinor", lines_tax, ord."shippingTaxMinor", ord."codFeeTaxMinor";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "customer_order_totals_trg" AFTER INSERT OR UPDATE ON "customer_order"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "order_totals_integrity"();
CREATE CONSTRAINT TRIGGER "order_line_totals_trg" AFTER INSERT OR UPDATE OR DELETE ON "order_line"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "order_totals_integrity"();
