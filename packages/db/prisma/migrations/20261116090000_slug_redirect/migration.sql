-- Istoric de adrese pentru redirecționări 301 (Faza 7, C-43). Tabel nou, fără date existente.

-- CreateTable
CREATE TABLE "slug_redirect" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "oldKey" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slug_redirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slug_redirect_kind_oldKey_key" ON "slug_redirect"("kind", "oldKey");

-- CreateIndex
CREATE INDEX "slug_redirect_kind_targetId_idx" ON "slug_redirect"("kind", "targetId");

-- Tipurile permise și cheia în litere mici, nevidă (coloane NOT NULL: comparațiile nu pot da NULL).
ALTER TABLE "slug_redirect"
  ADD CONSTRAINT "slug_redirect_kind_check" CHECK ("kind" IN ('product', 'category', 'brand')),
  ADD CONSTRAINT "slug_redirect_old_key_check" CHECK ("oldKey" <> '' AND "oldKey" = lower("oldKey"));
