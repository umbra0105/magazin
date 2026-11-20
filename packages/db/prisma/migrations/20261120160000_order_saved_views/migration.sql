-- Faza 11: vederile salvate ale listei de comenzi, proprii fiecărui utilizator (migrare ADITIVĂ: un tabel nou).
-- Vederea păstrează doar șirul de interogare al filtrelor (fără date personale); numele e unic per utilizator.
CREATE TABLE "order_saved_view" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_saved_view_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_saved_view_userId_name_key" ON "order_saved_view"("userId", "name");
CREATE INDEX "order_saved_view_userId_createdAt_idx" ON "order_saved_view"("userId", "createdAt");

ALTER TABLE "order_saved_view" ADD CONSTRAINT "order_saved_view_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_saved_view" ADD CONSTRAINT "order_saved_view_lengths_check"
    CHECK (char_length("name") BETWEEN 1 AND 40 AND char_length("query") <= 1000);
