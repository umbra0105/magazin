-- Faza 11, pasul 3 (migrare ADITIVĂ: tabel nou și relaxarea ținută a unei garanții, fără DROP de date).
--
-- 1) `order_note`: notele interne ale comenzii (autor, moment, text). Doar se adaugă (nu se editează și nu se șterg din aplicație).
CREATE TABLE "order_note" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "authorLabel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_note_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_note_orderId_createdAt_idx" ON "order_note"("orderId", "createdAt");

ALTER TABLE "order_note" ADD CONSTRAINT "order_note_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "customer_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_note" ADD CONSTRAINT "order_note_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 2000 AND char_length("authorLabel") >= 1);

-- 2) Corectarea adresei unei comenzi plasate (decizia din 2026-11-19, punctul d): adresa rămâne un snapshot, dar se pot corecta
--    numele, telefonul, strada și codul poștal (greșeli de tastare). NU se pot schimba: comanda, tipul adresei, județul și
--    localitatea (zona de livrare și tariful), țara, firma, CUI-ul și verificarea lui (facturare, Faza 13), momentul creării.
--    Fiecare corectare scrie `OrderEvent` și audit în aplicație.
CREATE OR REPLACE FUNCTION "address_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."countySirutaCode" IS DISTINCT FROM OLD."countySirutaCode"
    OR NEW."countyName" IS DISTINCT FROM OLD."countyName"
    OR NEW."localitySirutaCode" IS DISTINCT FROM OLD."localitySirutaCode"
    OR NEW."localityName" IS DISTINCT FROM OLD."localityName"
    OR NEW."country" IS DISTINCT FROM OLD."country"
    OR NEW."company" IS DISTINCT FROM OLD."company"
    OR NEW."vatId" IS DISTINCT FROM OLD."vatId"
    OR NEW."vatIdVerification" IS DISTINCT FROM OLD."vatIdVerification"
    OR NEW."tradeRegisterNo" IS DISTINCT FROM OLD."tradeRegisterNo"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Adresa comenzii este un snapshot imuabil: se pot corecta doar numele, telefonul, strada și codul poștal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
