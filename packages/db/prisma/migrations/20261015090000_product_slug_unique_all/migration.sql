-- Adresa unui produs e unică pe TOATE produsele, inclusiv cele șterse (soft delete): o adresă a unui
-- produs șters nu se refolosește (restaurare, redirecționări 301). Înainte era unică doar printre
-- cele neșterse (index parțial). Serviciul de catalog verifică același lucru, cu mesaj clar.
DROP INDEX "product_slug_active_key";
CREATE UNIQUE INDEX "product_slug_key" ON "product" (lower("slug"));
