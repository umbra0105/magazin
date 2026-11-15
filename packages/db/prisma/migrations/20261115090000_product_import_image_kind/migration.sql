-- Imaginile din descrierile WooCommerce (Faza 4, punctul 15d): aceleași sarcini de descărcare ca la imaginile produsului,
-- cu un tip. `product` = imaginea din coloana «Imagini» (se atașează produsului); `description` = imaginea dintr-o descriere
-- (intră în HTML-ul descrierii prin <img data-media-id>, nu în galeria produsului). Rândurile existente rămân `product`.

-- AlterTable
ALTER TABLE "product_import_image" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'product';

-- Valorile permise (un singur câmp, fără NULL: coloana e NOT NULL).
ALTER TABLE "product_import_image"
  ADD CONSTRAINT "product_import_image_kind_check" CHECK ("kind" IN ('product', 'description'));
