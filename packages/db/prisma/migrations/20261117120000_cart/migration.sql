-- Coșul (Faza 8). Două tabele NOI, fără date existente; nicio coloană și niciun tabel existent nu se atinge.

-- CreateTable
CREATE TABLE "cart" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_item" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "ackedUnitPriceMinor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cart_userId_key" ON "cart"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_tokenHash_key" ON "cart"("tokenHash");

-- CreateIndex
CREATE INDEX "cart_expiresAt_idx" ON "cart"("expiresAt");

-- CreateIndex
CREATE INDEX "cart_item_variantId_idx" ON "cart_item"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_item_cartId_variantId_key" ON "cart_item"("cartId", "variantId");

-- AddForeignKey
ALTER TABLE "cart" ADD CONSTRAINT "cart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "cart_item_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Proprietarul coșului: EXACT unul dintre utilizator și amprenta tokenului de oaspete. Comparații explicite pe fiecare
-- coloană (un CHECK cu rezultat NULL TRECE: «una setată, una nulă» nu are voie să treacă pe ramura greșită).
ALTER TABLE "cart"
  ADD CONSTRAINT "cart_owner_check" CHECK (
    ("userId" IS NOT NULL AND "tokenHash" IS NULL)
    OR ("userId" IS NULL AND "tokenHash" IS NOT NULL)
  );

-- Cantitatea: pozitivă și cel mult MAX_QUANTITY (1.000.000.000.000 zecimi de miime); prețul confirmat, dacă există, ≥ 0.
ALTER TABLE "cart_item"
  ADD CONSTRAINT "cart_item_quantity_check" CHECK ("quantity" > 0 AND "quantity" <= 1000000000000),
  ADD CONSTRAINT "cart_item_acked_price_check" CHECK (
    "ackedUnitPriceMinor" IS NULL OR "ackedUnitPriceMinor" >= 0
  );
