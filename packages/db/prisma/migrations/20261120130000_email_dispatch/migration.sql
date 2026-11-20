-- Faza 11, pasul 2 (migrare ADITIVĂ: două tabele noi, fără DROP și fără pierdere de date).
--
-- 1) `email_dispatch`: emailurile tranzacționale de trimis (outbox). Rândul se scrie în aceeași tranzacție cu evenimentul care
--    îl declanșează; unicitatea (eventKey, template, recipient) e garanția «o singură dată per eveniment», în baza de date.
CREATE TABLE "email_dispatch" (
    "id" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'customer',
    "orderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "data" JSONB,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_dispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_dispatch_eventKey_template_recipient_key" ON "email_dispatch"("eventKey", "template", "recipient");
CREATE INDEX "email_dispatch_status_createdAt_idx" ON "email_dispatch"("status", "createdAt");
CREATE INDEX "email_dispatch_orderId_idx" ON "email_dispatch"("orderId");

ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Valori permise și coerența «trimis»: `sentAt` e setat DOAR când starea e «sent» (comparații explicite pe fiecare coloană).
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_status_check"
    CHECK ("status" IN ('queued', 'sending', 'sent', 'failed', 'skipped'));
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_audience_check"
    CHECK ("audience" IN ('customer', 'internal'));
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_attempts_check"
    CHECK ("attempts" >= 0);
ALTER TABLE "email_dispatch" ADD CONSTRAINT "email_dispatch_sent_at_check" CHECK (
    ("status" = 'sent' AND "sentAt" IS NOT NULL)
    OR ("status" <> 'sent' AND "sentAt" IS NULL)
);

-- 2) `email_template_override`: subiectul și textul de început suprascrise pentru un șablon (revenirea la implicit = ștergerea rândului).
CREATE TABLE "email_template_override" (
    "template" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_template_override_pkey" PRIMARY KEY ("template")
);

ALTER TABLE "email_template_override" ADD CONSTRAINT "email_template_override_lengths_check"
    CHECK (char_length("subject") BETWEEN 1 AND 200 AND char_length("intro") BETWEEN 1 AND 2000);
