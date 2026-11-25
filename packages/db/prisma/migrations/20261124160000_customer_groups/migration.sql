-- Faza 15: GRUPURI DE CLIENȚI. Migrare ADITIVĂ (fără DROP/TRUNCATE/DELETE): tabela `customer_group`, grupul pe utilizator și snapshot-ul
-- grupului pe comandă. Clienții existenți rămân fără grup (= «Client standard», prețul public); nicio comandă veche nu se schimbă.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "customerGroupId" TEXT;

-- AlterTable
ALTER TABLE "customer_order" ADD COLUMN     "customerGroupId" TEXT,
ADD COLUMN     "groupAdvantageMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "groupDiscountBps" INTEGER,
ADD COLUMN     "groupMarkupBps" INTEGER;

-- CreateTable
CREATE TABLE "customer_group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "pricingType" TEXT NOT NULL DEFAULT 'none',
    "discountBps" INTEGER,
    "markupBps" INTEGER,
    "stacksWithSalePrice" BOOLEAN NOT NULL DEFAULT false,
    "earnsLoyaltyPoints" BOOLEAN NOT NULL DEFAULT true,
    "tone" TEXT NOT NULL DEFAULT 'neutral',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_group_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_group_slug_key" ON "customer_group"("slug");

-- CreateIndex
CREATE INDEX "customer_group_sortOrder_idx" ON "customer_group"("sortOrder");

-- CreateIndex
CREATE INDEX "user_customerGroupId_idx" ON "user"("customerGroupId");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "customer_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_customerGroupId_fkey" FOREIGN KEY ("customerGroupId") REFERENCES "customer_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Constrângeri (comparații explicite IS NULL / IS NOT NULL; un CHECK cu rezultat NULL TRECE) ───

-- Tipul de preț și procentele lui: «none» fără procente; «discount» doar cu reducere (0–100%); «cost_plus» doar cu adaos (0–10000%).
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_pricing_check" CHECK (
  ("pricingType" = 'none' AND "discountBps" IS NULL AND "markupBps" IS NULL)
  OR ("pricingType" = 'discount' AND "discountBps" IS NOT NULL AND "markupBps" IS NULL
      AND "discountBps" >= 0 AND "discountBps" <= 10000)
  OR ("pricingType" = 'cost_plus' AND "markupBps" IS NOT NULL AND "discountBps" IS NULL
      AND "markupBps" >= 0 AND "markupBps" <= 1000000)
);
-- Cumularea cu promoția are sens doar la «discount» (la «cost_plus» se ia oricum minimul).
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_stacks_check" CHECK (
  "stacksWithSalePrice" = false OR "pricingType" = 'discount'
);
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_tone_check" CHECK (
  "tone" IN ('neutral', 'info', 'success', 'warning', 'danger', 'accent')
);
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_name_check" CHECK (
  length(btrim("name")) > 0 AND length(btrim("slug")) > 0
);
-- Grupul de sistem («Client standard») e mereu «none» și activ.
ALTER TABLE "customer_group" ADD CONSTRAINT "customer_group_system_check" CHECK (
  "isSystem" = false OR ("pricingType" = 'none' AND "isActive" = true)
);
-- Cel mult un grup de sistem.
CREATE UNIQUE INDEX "customer_group_system_key" ON "customer_group" ((true)) WHERE "isSystem";

-- Grupul de sistem nu se șterge și «de sistem» nu se schimbă în niciun sens.
CREATE FUNCTION "customer_group_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isSystem" THEN
      RAISE EXCEPTION 'customer_group_system: grupul de sistem nu se șterge' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."isSystem" IS DISTINCT FROM OLD."isSystem" THEN
    RAISE EXCEPTION 'customer_group_system: «de sistem» nu se schimbă' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "customer_group_guard_trg" BEFORE UPDATE OR DELETE ON "customer_group"
  FOR EACH ROW EXECUTE FUNCTION "customer_group_guard"();

-- Snapshot-ul grupului pe comandă: «none» fără procente și fără avantaj; «discount» / «cost_plus» cu grupul și procentul lor.
ALTER TABLE "customer_order" ADD CONSTRAINT "customer_order_group_snapshot_check" CHECK (
  "groupAdvantageMinor" >= 0
  AND (
    ("groupPricingType" = 'none' AND "groupDiscountBps" IS NULL AND "groupMarkupBps" IS NULL AND "groupAdvantageMinor" = 0)
    OR ("groupPricingType" = 'discount' AND "customerGroupId" IS NOT NULL AND "groupDiscountBps" IS NOT NULL
        AND "groupMarkupBps" IS NULL AND "groupDiscountBps" >= 0 AND "groupDiscountBps" <= 10000)
    OR ("groupPricingType" = 'cost_plus' AND "customerGroupId" IS NOT NULL AND "groupMarkupBps" IS NOT NULL
        AND "groupDiscountBps" IS NULL AND "groupMarkupBps" >= 0 AND "groupMarkupBps" <= 1000000)
  )
);
