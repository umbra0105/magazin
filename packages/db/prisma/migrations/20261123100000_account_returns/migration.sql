-- AlterTable
ALTER TABLE "user" ADD COLUMN     "anonymizedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "customer_address" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "fullName" TEXT NOT NULL,
    "company" TEXT,
    "vatId" TEXT,
    "vatIdVerification" TEXT,
    "tradeRegisterNo" TEXT,
    "phone" TEXT NOT NULL,
    "countySirutaCode" INTEGER NOT NULL,
    "countyName" TEXT NOT NULL,
    "localitySirutaCode" INTEGER NOT NULL,
    "localityName" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'RO',
    "isDefaultShipping" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultBilling" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_item" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_preference" (
    "userId" TEXT NOT NULL,
    "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
    "marketingDecisionAt" TIMESTAMP(3),
    "marketingDecisionText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_preference_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "return_request" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "customerNote" TEXT,
    "sendMode" TEXT NOT NULL DEFAULT 'courier',
    "returnCarrier" TEXT,
    "returnAwb" TEXT,
    "returnTrackingUrl" TEXT,
    "returnAwbAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "adminNote" TEXT,
    "refundId" TEXT,
    "refundProductsMinor" INTEGER,
    "refundShippingMinor" INTEGER NOT NULL DEFAULT 0,
    "refundShippingReason" TEXT,
    "stornoState" TEXT,
    "stornoNote" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "inspectedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_item" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "requestedQty" BIGINT NOT NULL,
    "acceptedQty" BIGINT,
    "condition" TEXT,
    "resellable" BOOLEAN,
    "refundLineMinor" INTEGER,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "restockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_event" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "visibleToCustomer" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_address_userId_idx" ON "customer_address"("userId");

-- CreateIndex
CREATE INDEX "customer_address_countySirutaCode_idx" ON "customer_address"("countySirutaCode");

-- CreateIndex
CREATE INDEX "customer_address_localitySirutaCode_idx" ON "customer_address"("localitySirutaCode");

-- CreateIndex
CREATE INDEX "wishlist_item_variantId_idx" ON "wishlist_item"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "wishlist_item_userId_variantId_key" ON "wishlist_item"("userId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "return_request_number_key" ON "return_request"("number");

-- CreateIndex
CREATE INDEX "return_request_orderId_idx" ON "return_request"("orderId");

-- CreateIndex
CREATE INDEX "return_request_status_requestedAt_idx" ON "return_request"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "return_request_refundId_idx" ON "return_request"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "return_request_userId_clientKey_key" ON "return_request"("userId", "clientKey");

-- CreateIndex
CREATE INDEX "return_item_orderLineId_idx" ON "return_item"("orderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "return_item_returnId_orderLineId_key" ON "return_item"("returnId", "orderLineId");

-- CreateIndex
CREATE INDEX "return_event_returnId_createdAt_idx" ON "return_event"("returnId", "createdAt");

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_countySirutaCode_fkey" FOREIGN KEY ("countySirutaCode") REFERENCES "siruta_unit"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_localitySirutaCode_fkey" FOREIGN KEY ("localitySirutaCode") REFERENCES "siruta_unit"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_item" ADD CONSTRAINT "wishlist_item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_item" ADD CONSTRAINT "wishlist_item_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_preference" ADD CONSTRAINT "customer_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "return_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_event" ADD CONSTRAINT "return_event_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "return_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Faza 14: constrângeri și triggere (aditiv; niciun DROP, TRUNCATE sau DELETE)
-- ===========================================================================

-- Agenda de adrese: cel mult o adresă implicită de livrare și una de facturare pe client.
CREATE UNIQUE INDEX "customer_address_default_shipping_uq" ON "customer_address"("userId") WHERE "isDefaultShipping";
CREATE UNIQUE INDEX "customer_address_default_billing_uq" ON "customer_address"("userId") WHERE "isDefaultBilling";

-- Preferințe: fără decizie salvată = oprit; o decizie păstrează momentul ȘI textul arătat, împreună (comparații explicite: un CHECK cu
-- rezultat NULL TRECE).
ALTER TABLE "customer_preference" ADD CONSTRAINT "customer_preference_decision_ck" CHECK (
  ("marketingDecisionAt" IS NULL AND "marketingDecisionText" IS NULL AND "marketingOptIn" = false)
  OR ("marketingDecisionAt" IS NOT NULL AND "marketingDecisionText" IS NOT NULL)
);

-- Retur: valori, AWB împreună, motiv de respingere, rambursare.
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_status_ck" CHECK (
  "status" IN ('requested', 'approved', 'awaiting_shipment', 'received', 'inspected', 'refunded', 'rejected', 'cancelled')
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_send_mode_ck" CHECK ("sendMode" IN ('courier', 'drop_off'));
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_storno_state_ck" CHECK (
  "stornoState" IS NULL OR "stornoState" IN ('queued', 'covered_by_total', 'not_needed', 'failed')
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_awb_ck" CHECK (
  ("returnAwb" IS NULL AND "returnCarrier" IS NULL AND "returnAwbAt" IS NULL)
  OR ("returnAwb" IS NOT NULL AND "returnCarrier" IS NOT NULL AND "returnAwbAt" IS NOT NULL)
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_rejected_ck" CHECK (
  "status" <> 'rejected' OR ("rejectReason" IS NOT NULL AND "rejectedAt" IS NOT NULL)
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_cancelled_ck" CHECK (
  "status" <> 'cancelled' OR "cancelledAt" IS NOT NULL
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refunded_ck" CHECK (
  "status" <> 'refunded' OR ("refundId" IS NOT NULL AND "refundedAt" IS NOT NULL)
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refund_amount_ck" CHECK (
  ("refundId" IS NULL OR "refundProductsMinor" IS NOT NULL)
  AND ("refundProductsMinor" IS NULL OR "refundProductsMinor" >= 0)
  AND "refundShippingMinor" >= 0
);
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refund_shipping_reason_ck" CHECK (
  "refundShippingMinor" = 0 OR ("refundShippingReason" IS NOT NULL AND btrim("refundShippingReason") <> '')
);

-- Linie de retur: cantități, inspecție (cele trei câmpuri împreună), repunere pe stoc, motiv.
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_requested_qty_ck" CHECK ("requestedQty" > 0);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_inspection_ck" CHECK (
  ("acceptedQty" IS NULL AND "condition" IS NULL AND "resellable" IS NULL)
  OR ("acceptedQty" IS NOT NULL AND "condition" IS NOT NULL AND "resellable" IS NOT NULL)
);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_accepted_range_ck" CHECK (
  "acceptedQty" IS NULL OR ("acceptedQty" >= 0 AND "acceptedQty" <= "requestedQty")
);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_condition_ck" CHECK (
  "condition" IS NULL OR "condition" IN ('as_new', 'opened', 'damaged', 'defective', 'wrong_item')
);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_restocked_ck" CHECK (
  "restockedAt" IS NULL
  OR ("resellable" IS NOT NULL AND "resellable" = true AND "acceptedQty" IS NOT NULL AND "acceptedQty" > 0)
);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_refund_line_ck" CHECK (
  "refundLineMinor" IS NULL OR ("acceptedQty" IS NOT NULL AND "refundLineMinor" >= 0)
);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_reason_ck" CHECK (
  "reasonCode" IN ('changed_mind', 'defective', 'not_as_described', 'wrong_item', 'damaged_in_transit', 'other')
);
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_reason_text_ck" CHECK (
  "reasonCode" <> 'other' OR ("reasonText" IS NOT NULL AND btrim("reasonText") <> '')
);

-- Cantitatea returnată a unei linii nu depășește cantitatea comandată: la inserare se BLOCHEAZĂ linia de comandă (două cereri simultane
-- pentru ultima bucată se serializează: a doua vede ce a comis prima). Cantitatea «activă» a unui retur: cerută cât timp nu e inspectat,
-- acceptată după inspecție, zero dacă e respins sau anulat.
CREATE FUNCTION "return_item_guard"() RETURNS trigger AS $$
DECLARE
  line_qty BIGINT;
  line_order TEXT;
  ret_order TEXT;
  ret_status TEXT;
  used NUMERIC;
BEGIN
  SELECT "quantity", "orderId" INTO line_qty, line_order FROM "order_line" WHERE "id" = NEW."orderLineId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_item_line_missing: linia de comandă % nu există', NEW."orderLineId" USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT "orderId", "status" INTO ret_order, ret_status FROM "return_request" WHERE "id" = NEW."returnId";
  IF ret_order IS DISTINCT FROM line_order THEN
    RAISE EXCEPTION 'return_item_wrong_order: linia % nu aparține comenzii returului', NEW."orderLineId" USING ERRCODE = 'check_violation';
  END IF;
  IF ret_status IS DISTINCT FROM 'requested' THEN
    RAISE EXCEPTION 'return_item_not_open: liniile se adaugă doar la crearea returului' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(
    CASE
      WHEN r."status" IN ('requested', 'approved', 'awaiting_shipment', 'received') THEN i."requestedQty"
      WHEN r."status" IN ('inspected', 'refunded') THEN COALESCE(i."acceptedQty", 0)
      ELSE 0
    END), 0)
  INTO used
  FROM "return_item" i JOIN "return_request" r ON r."id" = i."returnId"
  WHERE i."orderLineId" = NEW."orderLineId";
  IF used + NEW."requestedQty" > line_qty THEN
    RAISE EXCEPTION 'return_quantity_exceeded: se returnează mai mult decât s-a comandat (comandat %, deja în retururi %, cerut %)',
      line_qty, used, NEW."requestedQty" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "return_item_guard_trg" BEFORE INSERT ON "return_item"
  FOR EACH ROW EXECUTE FUNCTION "return_item_guard"();

-- Ce a cerut clientul nu se mai schimbă, iar repunerea pe stoc se face o singură dată (marcajul nu se șterge, iar inspecția unei linii
-- repuse pe stoc nu se mai poate modifica).
CREATE FUNCTION "return_item_frozen"() RETURNS trigger AS $$
BEGIN
  IF NEW."requestedQty" IS DISTINCT FROM OLD."requestedQty"
    OR NEW."orderLineId" IS DISTINCT FROM OLD."orderLineId"
    OR NEW."returnId" IS DISTINCT FROM OLD."returnId" THEN
    RAISE EXCEPTION 'return_item_frozen: cererea clientului nu se modifică' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."restockedAt" IS NOT NULL AND (
    NEW."restockedAt" IS DISTINCT FROM OLD."restockedAt"
    OR NEW."acceptedQty" IS DISTINCT FROM OLD."acceptedQty"
    OR NEW."resellable" IS DISTINCT FROM OLD."resellable"
  ) THEN
    RAISE EXCEPTION 'return_item_restocked: linia a fost deja repusă pe stoc' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "return_item_frozen_trg" BEFORE UPDATE ON "return_item"
  FOR EACH ROW EXECUTE FUNCTION "return_item_frozen"();

-- Tranzițiile returului (a doua barieră după state machine-ul din aplicație):
-- requested → approved | rejected | cancelled; approved → awaiting_shipment | cancelled; awaiting_shipment → received | cancelled;
-- received → inspected; inspected → refunded | rejected. Restul sunt finale.
CREATE FUNCTION "return_status_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'requested' AND NEW."status" IN ('approved', 'rejected', 'cancelled'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('awaiting_shipment', 'cancelled'))
    OR (OLD."status" = 'awaiting_shipment' AND NEW."status" IN ('received', 'cancelled'))
    OR (OLD."status" = 'received' AND NEW."status" = 'inspected')
    OR (OLD."status" = 'inspected' AND NEW."status" IN ('refunded', 'rejected'))
  ) THEN
    RAISE EXCEPTION 'return_status_transition: tranziția % → % nu este permisă', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "return_status_transition_trg" BEFORE UPDATE OF "status" ON "return_request"
  FOR EACH ROW EXECUTE FUNCTION "return_status_transition"();

-- Jurnalul returului: doar se adaugă (ștergerea prin cascadă din retur rămâne posibilă la curățarea datelor de test).
CREATE FUNCTION "return_event_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'return_event_append_only: jurnalul returului nu se modifică';
  END IF;
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'return_event_append_only: jurnalul returului nu se șterge';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "return_event_append_only_trg" BEFORE UPDATE OR DELETE ON "return_event"
  FOR EACH ROW EXECUTE FUNCTION "return_event_append_only"();

-- Agenda de adrese: aceleași reguli ca adresa comenzii (cod poștal de 6 cifre; CUI cu starea verificării, împreună).
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_postal_code_ck" CHECK ("postalCode" ~ '^[0-9]{6}$');
ALTER TABLE "customer_address" ADD CONSTRAINT "customer_address_vat_ck" CHECK (
  ("vatId" IS NULL AND "vatIdVerification" IS NULL)
  OR ("vatId" IS NOT NULL AND "vatIdVerification" IS NOT NULL AND "vatIdVerification" IN ('verified', 'unverified'))
);
