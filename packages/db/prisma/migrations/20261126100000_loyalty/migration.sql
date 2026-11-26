-- AlterTable
ALTER TABLE "customer_order" ADD COLUMN     "loyaltyCustomerId" TEXT,
ADD COLUMN     "loyaltyEarnDueAt" TIMESTAMP(3),
ADD COLUMN     "loyaltyEarnRateMinor" INTEGER,
ADD COLUMN     "loyaltyGrantedAt" TIMESTAMP(3),
ADD COLUMN     "loyaltyPointValueMinor" INTEGER,
ADD COLUMN     "loyaltyPointsToEarn" INTEGER,
ADD COLUMN     "loyaltyPointsUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyaltyVatMode" TEXT;

-- AlterTable
ALTER TABLE "order_line" ADD COLUMN     "loyaltyDiscountMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loyaltyEarnEligible" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "return_item" ADD COLUMN     "loyaltyDiscountMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "loyalty_account" (
    "customerId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_account_pkey" PRIMARY KEY ("customerId")
);

-- CreateTable
CREATE TABLE "loyalty_transaction" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "actorId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_lot" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "originLotId" TEXT,
    "points" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "warnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_lot_entry" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_lot_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transaction_seq_key" ON "loyalty_transaction"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transaction_idempotencyKey_key" ON "loyalty_transaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "loyalty_transaction_customerId_seq_idx" ON "loyalty_transaction"("customerId", "seq");

-- CreateIndex
CREATE INDEX "loyalty_transaction_orderId_idx" ON "loyalty_transaction"("orderId");

-- CreateIndex
CREATE INDEX "loyalty_lot_customerId_expiresAt_idx" ON "loyalty_lot"("customerId", "expiresAt");

-- CreateIndex
CREATE INDEX "loyalty_lot_expiresAt_idx" ON "loyalty_lot"("expiresAt");

-- CreateIndex
CREATE INDEX "loyalty_lot_transactionId_idx" ON "loyalty_lot"("transactionId");

-- CreateIndex
CREATE INDEX "loyalty_lot_originLotId_idx" ON "loyalty_lot"("originLotId");

-- CreateIndex
CREATE INDEX "loyalty_lot_entry_lotId_idx" ON "loyalty_lot_entry"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_lot_entry_transactionId_lotId_key" ON "loyalty_lot_entry"("transactionId", "lotId");

-- CreateIndex
CREATE INDEX "customer_order_loyaltyCustomerId_idx" ON "customer_order"("loyaltyCustomerId");

-- CreateIndex
CREATE INDEX "customer_order_loyaltyEarnDueAt_idx" ON "customer_order"("loyaltyEarnDueAt");

-- AddForeignKey
ALTER TABLE "loyalty_account" ADD CONSTRAINT "loyalty_account_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "loyalty_account"("customerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "loyalty_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "loyalty_account"("customerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_originLotId_fkey" FOREIGN KEY ("originLotId") REFERENCES "loyalty_lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_lot_entry" ADD CONSTRAINT "loyalty_lot_entry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "loyalty_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_lot_entry" ADD CONSTRAINT "loyalty_lot_entry_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "loyalty_lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Faza 15b: constrângeri și triggere. Aditiv: nicio tabelă sau coloană ștearsă și niciun rând atins. Singurele constrângeri
-- ÎNLOCUITE (autorizate de utilizator la 2026-11-26) sunt trei, toate EXTINDERI ale regulilor vechi:
-- `invoice_line_kind_check`, `invoice_line_source_check` și `return_request_refunded_ck`. Niciun rând nu se modifică; o
-- constrângere adăugată fără NOT VALID verifică toate rândurile existente. Orice CHECK compus compară explicit.
-- ===========================================================================

-- Linia de reducere din puncte de pe factură: tip nou, legată de linia comenzii, fără SKU. Sumele rămân pozitive în bază
-- (`invoice_line_amounts_check` neschimbat); semnul negativ îl dă tipul, la trimiterea spre furnizor.
ALTER TABLE "invoice_line" DROP CONSTRAINT "invoice_line_kind_check";
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_kind_check"
    CHECK ("kind" IN ('product', 'shipping', 'cod_fee', 'discount'));
ALTER TABLE "invoice_line" DROP CONSTRAINT "invoice_line_source_check";
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_source_check" CHECK (
    ("kind" = 'product' AND "orderLineId" IS NOT NULL AND "sku" IS NOT NULL)
    OR ("kind" IN ('shipping', 'cod_fee') AND "orderLineId" IS NULL AND "sku" IS NULL)
    OR ("kind" = 'discount' AND "orderLineId" IS NOT NULL AND "sku" IS NULL)
);

-- Returul plătit integral cu puncte se închide fără rambursare: singurul caz nou e cu 0 lei pe produse ȘI pe transport.
ALTER TABLE "return_request" DROP CONSTRAINT "return_request_refunded_ck";
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_refunded_ck" CHECK (
  "status" <> 'refunded' OR (
    "refundedAt" IS NOT NULL AND (
      "refundId" IS NOT NULL
      OR ("refundId" IS NULL AND "refundProductsMinor" IS NOT NULL AND "refundProductsMinor" = 0 AND "refundShippingMinor" = 0)
    )
  )
);

-- Comanda: punctele folosite. Reducerea nu depășește produsele (punctele nu ating transportul); `totalMinor > 0` există deja.
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_loyalty_used_check" CHECK (
  ("loyaltyPointsUsed" = 0 AND "loyaltyPointValueMinor" IS NULL AND "loyaltyVatMode" IS NULL)
  OR ("loyaltyPointsUsed" > 0
      AND "loyaltyPointValueMinor" IS NOT NULL AND "loyaltyPointValueMinor" > 0
      AND "loyaltyVatMode" IS NOT NULL AND "loyaltyVatMode" = 'base_reduced'
      AND "loyaltyCustomerId" IS NOT NULL
      AND "discountMinor" >= "loyaltyPointsUsed"::bigint * "loyaltyPointValueMinor"
      AND "discountMinor" <= "subtotalMinor")
);

-- Comanda: punctele de primit.
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_loyalty_earn_check" CHECK (
  ("loyaltyEarnRateMinor" IS NULL AND "loyaltyPointsToEarn" IS NULL
      AND "loyaltyEarnDueAt" IS NULL AND "loyaltyGrantedAt" IS NULL)
  OR ("loyaltyEarnRateMinor" IS NOT NULL AND "loyaltyEarnRateMinor" > 0
      AND "loyaltyPointsToEarn" IS NOT NULL AND "loyaltyPointsToEarn" >= 0
      AND "loyaltyCustomerId" IS NOT NULL
      AND ("loyaltyGrantedAt" IS NULL OR "loyaltyEarnDueAt" IS NOT NULL))
);

ALTER TABLE "order_line" ADD CONSTRAINT "order_line_loyalty_check"
  CHECK ("loyaltyDiscountMinor" >= 0 AND "loyaltyDiscountMinor" <= "lineTotalMinor");
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_loyalty_check" CHECK ("loyaltyDiscountMinor" >= 0);

-- Instantaneul punctelor nu se schimbă după plasare (triggere separate: cele vechi nu se ating).
CREATE FUNCTION "customer_order_loyalty_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."loyaltyCustomerId" IS DISTINCT FROM OLD."loyaltyCustomerId"
    OR NEW."loyaltyPointsUsed" IS DISTINCT FROM OLD."loyaltyPointsUsed"
    OR NEW."loyaltyPointValueMinor" IS DISTINCT FROM OLD."loyaltyPointValueMinor"
    OR NEW."loyaltyVatMode" IS DISTINCT FROM OLD."loyaltyVatMode"
    OR NEW."loyaltyEarnRateMinor" IS DISTINCT FROM OLD."loyaltyEarnRateMinor"
    OR NEW."loyaltyPointsToEarn" IS DISTINCT FROM OLD."loyaltyPointsToEarn" THEN
    RAISE EXCEPTION 'Comanda este un snapshot imuabil: instantaneul punctelor nu se modifică după plasare';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "customer_order_loyalty_immutable_trg" BEFORE UPDATE ON "customer_order"
  FOR EACH ROW EXECUTE FUNCTION "customer_order_loyalty_immutable"();

CREATE FUNCTION "order_line_loyalty_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."loyaltyDiscountMinor" IS DISTINCT FROM OLD."loyaltyDiscountMinor"
    OR NEW."loyaltyEarnEligible" IS DISTINCT FROM OLD."loyaltyEarnEligible" THEN
    RAISE EXCEPTION 'Linia de comandă este un snapshot imuabil: instantaneul punctelor nu se modifică';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "order_line_loyalty_immutable_trg" BEFORE UPDATE ON "order_line"
  FOR EACH ROW EXECUTE FUNCTION "order_line_loyalty_immutable"();

-- Registrul de puncte: tipuri, semne, câmpuri.
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_type_check"
  CHECK ("type" IN ('earn', 'redeem', 'release', 'expire', 'adjust', 'revoke'));
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_sign_check" CHECK (
  ("type" IN ('earn', 'release') AND "points" > 0)
  OR ("type" IN ('redeem', 'expire', 'revoke') AND "points" < 0)
  OR ("type" = 'adjust' AND "points" <> 0)
);
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_order_check" CHECK (
  ("type" IN ('earn', 'redeem', 'release', 'revoke') AND "orderId" IS NOT NULL)
  OR ("type" IN ('expire', 'adjust') AND "orderId" IS NULL)
);
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_adjust_check" CHECK (
  ("type" = 'adjust' AND "reason" IS NOT NULL AND length(btrim("reason")) > 0 AND "actorId" IS NOT NULL)
  OR ("type" <> 'adjust' AND "actorId" IS NULL)
);
-- o singură răscumpărare și o singură acumulare pe comandă (idempotență garantată de bază)
CREATE UNIQUE INDEX "loyalty_transaction_redeem_order_uq" ON "loyalty_transaction"("orderId") WHERE "type" = 'redeem';
CREATE UNIQUE INDEX "loyalty_transaction_earn_order_uq" ON "loyalty_transaction"("orderId") WHERE "type" = 'earn';

ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_points_check" CHECK ("points" > 0);
ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_remaining_check"
  CHECK ("remaining" >= 0 AND "remaining" <= "points");
ALTER TABLE "loyalty_lot_entry" ADD CONSTRAINT "loyalty_lot_entry_points_check" CHECK ("points" < 0);

-- Contul: pornește de la 0; soldul se schimbă DOAR din triggerul registrului (adâncime de trigger cel puțin 2).
CREATE FUNCTION "loyalty_account_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance" <> 0 THEN
      RAISE EXCEPTION 'loyalty_account_balance: un cont nou pornește de la soldul 0' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    RAISE EXCEPTION 'loyalty_account_owner: contul de puncte nu își schimbă clientul' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."balance" IS DISTINCT FROM OLD."balance" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'loyalty_account_balance: soldul nu se editează direct; se scrie o tranzacție în registru'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "loyalty_account_guard_trg" BEFORE INSERT OR UPDATE ON "loyalty_account"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_account_guard"();

-- Tranzacția: blochează contul (cererile simultane pe același client se serializează), calculează soldul de după și refuză orice
-- scădere sub 0 în afară de revocarea unui retur. Soldul se scrie în triggerul AFTER, deci doar dacă rândul chiar a intrat.
-- Inserările în registru se fac câte un rând pe instrucțiune (triggerul AFTER verifică).
CREATE FUNCTION "loyalty_transaction_prepare"() RETURNS trigger AS $$
DECLARE
  current_balance INTEGER;
BEGIN
  SELECT "balance" INTO current_balance FROM "loyalty_account" WHERE "customerId" = NEW."customerId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'loyalty_account_missing: contul de puncte nu există' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."balanceAfter" := current_balance + NEW."points";
  IF NEW."points" < 0 AND NEW."type" <> 'revoke' AND NEW."balanceAfter" < 0 THEN
    RAISE EXCEPTION 'loyalty_balance_negative: sold insuficient (sold %, cerut %)', current_balance, -NEW."points"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "loyalty_transaction_prepare_trg" BEFORE INSERT ON "loyalty_transaction"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_transaction_prepare"();

CREATE FUNCTION "loyalty_transaction_apply"() RETURNS trigger AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE "loyalty_account" SET "balance" = "balance" + NEW."points", "updatedAt" = CURRENT_TIMESTAMP
    WHERE "customerId" = NEW."customerId" RETURNING "balance" INTO new_balance;
  IF new_balance IS DISTINCT FROM NEW."balanceAfter" THEN
    RAISE EXCEPTION 'loyalty_ledger_multi_row: o singură tranzacție de puncte pe instrucțiune';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "loyalty_transaction_apply_trg" AFTER INSERT ON "loyalty_transaction"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_transaction_apply"();

-- Imuabilitate: rândurile registrului și consumurile loturilor nu se modifică și nu se șterg direct. Ștergerea prin cascadă din
-- contul de puncte rămâne posibilă doar la curățarea datelor de test (aplicația nu șterge niciodată un cont: gardă în teste).
CREATE FUNCTION "loyalty_ledger_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'loyalty_ledger_immutable: rândurile registrului de puncte nu se modifică';
  END IF;
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'loyalty_ledger_immutable: rândurile registrului de puncte nu se șterg';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "loyalty_transaction_immutable_trg" BEFORE UPDATE OR DELETE ON "loyalty_transaction"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_ledger_immutable"();
CREATE TRIGGER "loyalty_lot_entry_immutable_trg" BEFORE UPDATE OR DELETE ON "loyalty_lot_entry"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_ledger_immutable"();

-- Lotul: se naște plin, dintr-o tranzacție pozitivă a aceluiași client, fără să depășească punctele ei; restul se schimbă doar
-- din triggerul consumului; data de expirare nu se schimbă niciodată.
CREATE FUNCTION "loyalty_lot_guard"() RETURNS trigger AS $$
DECLARE
  tx_customer TEXT;
  tx_type TEXT;
  tx_points INTEGER;
  already BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'loyalty_lot_delete: loturile de puncte nu se șterg';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "customerId", "type", "points" INTO tx_customer, tx_type, tx_points
      FROM "loyalty_transaction" WHERE "id" = NEW."transactionId";
    IF tx_customer IS DISTINCT FROM NEW."customerId" OR tx_type NOT IN ('earn', 'release', 'adjust') OR tx_points <= 0 THEN
      RAISE EXCEPTION 'loyalty_lot_source: lotul vine dintr-o tranzacție pozitivă a aceluiași client' USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM("points"), 0) INTO already FROM "loyalty_lot" WHERE "transactionId" = NEW."transactionId";
    IF already + NEW."points" > tx_points THEN
      RAISE EXCEPTION 'loyalty_lot_source: loturile depășesc punctele tranzacției' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."remaining" IS DISTINCT FROM NEW."points" THEN
      RAISE EXCEPTION 'loyalty_lot_new: un lot nou are restul egal cu punctele' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."transactionId" IS DISTINCT FROM OLD."transactionId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."originLotId" IS DISTINCT FROM OLD."originLotId"
    OR NEW."points" IS DISTINCT FROM OLD."points"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'loyalty_lot_frozen: datele unui lot de puncte nu se modifică' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remaining" IS DISTINCT FROM OLD."remaining" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'loyalty_lot_remaining: restul unui lot se schimbă doar printr-un consum' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "loyalty_lot_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "loyalty_lot"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_lot_guard"();

CREATE FUNCTION "loyalty_lot_entry_apply"() RETURNS trigger AS $$
DECLARE
  tx_customer TEXT;
  lot_customer TEXT;
BEGIN
  SELECT "customerId" INTO tx_customer FROM "loyalty_transaction" WHERE "id" = NEW."transactionId";
  UPDATE "loyalty_lot" SET "remaining" = "remaining" + NEW."points" WHERE "id" = NEW."lotId"
    RETURNING "customerId" INTO lot_customer;
  IF tx_customer IS DISTINCT FROM lot_customer THEN
    RAISE EXCEPTION 'loyalty_lot_owner: consumul și lotul sunt ale aceluiași client' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "loyalty_lot_entry_apply_trg" AFTER INSERT ON "loyalty_lot_entry"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_lot_entry_apply"();
