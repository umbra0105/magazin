-- Faza 5, punctul 9a: denumirea pasului de vânzare («sac», «rolă», «cutie»), pentru afișarea prețului pe pas.
-- AlterTable
ALTER TABLE "product" ADD COLUMN     "saleStepLabel" TEXT;

-- Gol (nul) sau 1–30 de caractere, fără spații la capete. Coloana e comparată explicit cu NULL: un CHECK cu rezultat NULL TRECE.
ALTER TABLE "product"
  ADD CONSTRAINT "product_saleStepLabel_check" CHECK (
    "saleStepLabel" IS NULL
    OR (
      "saleStepLabel" IS NOT NULL
      AND char_length("saleStepLabel") BETWEEN 1 AND 30
      AND "saleStepLabel" = btrim("saleStepLabel")
    )
  );
