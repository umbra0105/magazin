-- Fișa explodată (Faza 4, blocul 11d): ștergerea definitivă a unui produs NU mai șterge hotspot-urile
-- care îl indică. Hotspot-ul rămâne în fișă, fără produs (vizibil ca atare în editor), ca fișa să nu se
-- rupă. Produsele din catalog se șterg de regulă „soft” (`deletedAt`), caz în care rândul rămâne legat.

-- AlterTable
ALTER TABLE "parts_diagram_hotspot" ALTER COLUMN "productId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "parts_diagram_hotspot" DROP CONSTRAINT "parts_diagram_hotspot_productId_fkey";

-- AddForeignKey
ALTER TABLE "parts_diagram_hotspot" ADD CONSTRAINT "parts_diagram_hotspot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
