-- Faza 11, pasul 1 (migrare ADITIVĂ: coloane noi, fără DROP, fără pierdere de date).
--
-- 1) Marcajul «La furnizor» pe comandă (decizia din 2026-11-19): NU e stare nouă în `fulfillmentStatus`, nu atinge stocul,
--    banii sau statusurile. Toate coloanele nule = comandă nemarcată; marcată = `supplierMarkedAt` și `supplierMarkedBy` setate.
ALTER TABLE "customer_order" ADD COLUMN "supplierMarkedAt" TIMESTAMP(3);
ALTER TABLE "customer_order" ADD COLUMN "supplierMarkedBy" TEXT;
ALTER TABLE "customer_order" ADD COLUMN "supplierName" TEXT;
ALTER TABLE "customer_order" ADD COLUMN "supplierNote" TEXT;

-- CHECK compus cu comparații explicite pe fiecare coloană (un CHECK cu rezultat NULL TRECE): nemarcată = toate nule;
-- marcată = momentul și autorul setați (furnizorul și nota sunt opționale), cu lungimi limitate.
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_supplier_mark_check" CHECK (
  (
    "supplierMarkedAt" IS NULL
    AND "supplierMarkedBy" IS NULL
    AND "supplierName" IS NULL
    AND "supplierNote" IS NULL
  )
  OR (
    "supplierMarkedAt" IS NOT NULL
    AND "supplierMarkedBy" IS NOT NULL
    AND ("supplierName" IS NULL OR char_length("supplierName") BETWEEN 1 AND 200)
    AND ("supplierNote" IS NULL OR char_length("supplierNote") BETWEEN 1 AND 1000)
  )
);

CREATE INDEX "customer_order_supplierMarkedAt_idx" ON "customer_order"("supplierMarkedAt");

-- 2) Rambursarea cerută de un actor CU LIMITĂ (rolul Suport): limita se aplică pe suma acestor rambursări pe comandă.
ALTER TABLE "refund" ADD COLUMN "limitedActor" BOOLEAN NOT NULL DEFAULT false;
