-- Faza 11 (cereri de instalare, docs/15 §4): starea de urmărire a cererii de instalare de pe comandă. Migrare ADITIVĂ: o coloană
-- nulabilă, o completare cu WHERE a comenzilor existente care au cerut instalare și un CHECK compus cu comparații explicite.
ALTER TABLE "customer_order" ADD COLUMN "installationStatus" TEXT;
ALTER TABLE "customer_order" ADD COLUMN "installationStatusAt" TIMESTAMP(3);

-- comenzile deja plasate cu instalare cerută primesc starea «requested» (altfel CHECK-ul de mai jos le-ar respinge)
UPDATE "customer_order" SET "installationStatus" = 'requested' WHERE "installationRequested" = true;

-- fără cerere: fără stare; cu cerere: una dintre stările din docs/15 §4 (requested | contacted | scheduled | done | declined)
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_installation_status_check" CHECK (
  ("installationRequested" = false AND "installationStatus" IS NULL AND "installationStatusAt" IS NULL)
  OR (
    "installationRequested" = true
    AND "installationStatus" IS NOT NULL
    AND "installationStatus" IN ('requested', 'contacted', 'scheduled', 'done', 'declined')
  )
);

CREATE INDEX "customer_order_installationStatus_idx" ON "customer_order"("installationStatus");
