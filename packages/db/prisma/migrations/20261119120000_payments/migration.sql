-- Faza 10: plăți online (card). Migrare ADITIVĂ: coloane și tabele noi; nimic nu se șterge.
--
-- Singurele modificări de constrângeri existente sunt extinderi STRICTE (superset: tot ce era valid rămâne valid), cerute pentru
-- metoda «card»: customer_order_payment_method_check, customer_order_reservation_check și payment_provider_check. Un DROP
-- CONSTRAINT urmat de ADD CONSTRAINT în aceeași migrație (tranzacție) nu pierde date. aprobat de utilizator, 2026-11-19,
-- extinderea CHECK pentru card.
--
-- Validarea datelor existente, înainte de orice modificare: nicio comandă sau plată existentă nu are valori în afara celor
-- vechi (altfel migrația se oprește, fără să schimbe nimic).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "customer_order" WHERE "paymentMethod" NOT IN ('cod', 'bank_transfer')) THEN
    RAISE EXCEPTION 'Faza 10: există comenzi cu o metodă de plată necunoscută; migrația se oprește';
  END IF;
  IF EXISTS (SELECT 1 FROM "payment" WHERE "provider" NOT IN ('cod', 'bank_transfer')) THEN
    RAISE EXCEPTION 'Faza 10: există plăți cu un furnizor necunoscut; migrația se oprește';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "integration" ADD COLUMN     "verifiedInSandboxAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "customer_order" ADD COLUMN     "paymentRetryDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "attemptNo" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "attentionAt" TIMESTAMP(3),
ADD COLUMN     "attentionReason" TEXT,
ADD COLUMN     "attentionResolvedAt" TIMESTAMP(3),
ADD COLUMN     "capturedAmountMinor" INTEGER,
ADD COLUMN     "capturedCurrency" TEXT,
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "mode" TEXT,
ADD COLUMN     "refundCommittedMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "actorLabel" TEXT,
    "failureMessage" TEXT,
    "manualReference" TEXT,
    "resolvedManually" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "rejectReason" TEXT,
    "bodyHash" TEXT NOT NULL,
    "paymentId" TEXT,
    "normalized" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payment_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_retry_token" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_retry_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refund_idempotencyKey_key" ON "refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "refund_paymentId_idx" ON "refund"("paymentId");

-- CreateIndex
CREATE INDEX "refund_orderId_idx" ON "refund"("orderId");

-- CreateIndex
CREATE INDEX "refund_status_createdAt_idx" ON "refund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_webhook_event_status_receivedAt_idx" ON "payment_webhook_event"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "payment_webhook_event_paymentId_idx" ON "payment_webhook_event"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_event_provider_eventId_key" ON "payment_webhook_event"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_retry_token_tokenHash_key" ON "payment_retry_token"("tokenHash");

-- CreateIndex
CREATE INDEX "payment_retry_token_orderId_idx" ON "payment_retry_token"("orderId");

-- CreateIndex
CREATE INDEX "payment_status_createdAt_idx" ON "payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_attentionAt_idx" ON "payment"("attentionAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orderId_attemptNo_key" ON "payment"("orderId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_providerRef_key" ON "payment"("provider", "providerRef");

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_retry_token" ADD CONSTRAINT "payment_retry_token_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Constrângeri. Fiecare CHECK compus compară explicit fiecare coloană cu NULL / NOT NULL (un CHECK cu rezultat NULL trece).

-- Comanda: metoda «card» (superset strict). Cardul are rezervarea curentă (nenulă) și fereastra de reîncercare (nenulă);
-- ramburs și transfer nu au fereastra de reîncercare.
ALTER TABLE "customer_order" DROP CONSTRAINT "customer_order_payment_method_check";
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_payment_method_check"
  CHECK ("paymentMethod" IN ('cod', 'bank_transfer', 'card'));
ALTER TABLE "customer_order" DROP CONSTRAINT "customer_order_reservation_check";
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_reservation_check"
  CHECK (("paymentMethod" = 'cod' AND "reservationExpiresAt" IS NULL)
      OR ("paymentMethod" = 'bank_transfer' AND "reservationExpiresAt" IS NOT NULL)
      OR ("paymentMethod" = 'card' AND "reservationExpiresAt" IS NOT NULL));
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_retry_deadline_check"
  CHECK (("paymentMethod" = 'card' AND "paymentRetryDeadlineAt" IS NOT NULL)
      OR ("paymentMethod" IN ('cod', 'bank_transfer') AND "paymentRetryDeadlineAt" IS NULL));

-- Plata (tentativa).
ALTER TABLE "payment" DROP CONSTRAINT "payment_provider_check";
ALTER TABLE "payment" ADD CONSTRAINT "payment_provider_check"
  CHECK ("provider" IN ('cod', 'bank_transfer', 'netopia', 'euplatesc', 'demo'));
ALTER TABLE "payment" ADD CONSTRAINT "payment_attempt_check" CHECK ("attemptNo" >= 1);
ALTER TABLE "payment" ADD CONSTRAINT "payment_mode_check"
  CHECK ("mode" IS NULL OR "mode" IN ('test', 'live', 'demo'));
ALTER TABLE "payment" ADD CONSTRAINT "payment_captured_amount_check"
  CHECK ("capturedAmountMinor" IS NULL OR "capturedAmountMinor" > 0);
ALTER TABLE "payment" ADD CONSTRAINT "payment_refund_cap_check"
  CHECK ("refundCommittedMinor" >= 0 AND "refundCommittedMinor" <= "amountMinor");
ALTER TABLE "payment" ADD CONSTRAINT "payment_refund_requires_capture_check"
  CHECK ("refundCommittedMinor" = 0 OR "capturedAt" IS NOT NULL);
ALTER TABLE "payment" ADD CONSTRAINT "payment_attention_check"
  CHECK (("attentionReason" IS NULL AND "attentionAt" IS NULL AND "attentionResolvedAt" IS NULL)
      OR ("attentionReason" IS NOT NULL AND "attentionAt" IS NOT NULL));
ALTER TABLE "payment" ADD CONSTRAINT "payment_card_last4_check"
  CHECK ("cardLast4" IS NULL OR "cardLast4" ~ '^[0-9]{4}$');

-- Rambursarea.
ALTER TABLE "refund" ADD CONSTRAINT "refund_status_check"
  CHECK ("status" IN ('requested', 'confirmed', 'failed', 'manual_required'));
ALTER TABLE "refund" ADD CONSTRAINT "refund_kind_check"
  CHECK ("kind" IN ('admin', 'auto_stock_lost', 'auto_late_payment'));
ALTER TABLE "refund" ADD CONSTRAINT "refund_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "refund" ADD CONSTRAINT "refund_reason_check" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "refund" ADD CONSTRAINT "refund_confirmed_check"
  CHECK (("status" = 'confirmed' AND "confirmedAt" IS NOT NULL)
      OR ("status" <> 'confirmed' AND "confirmedAt" IS NULL));

-- Evenimentul webhook: unul respins are motiv și moment; unul procesat are momentul procesării; hash-ul corpului e SHA-256 (hex).
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_status_check"
  CHECK ("status" IN ('received', 'processed', 'failed', 'rejected'));
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_reject_check"
  CHECK (("status" = 'rejected' AND "rejectReason" IS NOT NULL)
      OR ("status" <> 'rejected' AND "rejectReason" IS NULL));
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_processed_check"
  CHECK (("status" IN ('processed', 'rejected') AND "processedAt" IS NOT NULL)
      OR ("status" IN ('received', 'failed') AND "processedAt" IS NULL));
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_hash_check"
  CHECK ("bodyHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_attempts_check"
  CHECK ("attempts" >= 0);

-- Jetonul de reîncercare: amprentă SHA-256 (hex).
ALTER TABLE "payment_retry_token" ADD CONSTRAINT "payment_retry_token_hash_check"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
