-- Faza 10: momentul în care cererea de rambursare a fost TRIMISĂ procesatorului (migrare aditivă, o coloană nulabilă).
-- O cerere trimisă și rămasă fără rezultat nu se retrimite automat (risc de rambursare dublă): devine «manual_required».
ALTER TABLE "refund" ADD COLUMN "sentAt" TIMESTAMP(3);
