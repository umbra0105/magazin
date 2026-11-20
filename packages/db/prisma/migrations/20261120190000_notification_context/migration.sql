-- Faza 11, corecția C3: o linie scurtă de context pe notificarea din clopoțel («Comanda WEB-000123 · Plată dublă»), ca titlul să nu
-- rămână singur («O plată necesită atenție»). Migrare ADITIVĂ: o coloană nouă, nulă pentru notificările existente.
-- Contextul NU poartă date personale (doar numărul comenzii sau al ofertei și un motiv scurt); lungimea e păzită în bază:
-- NULL sau 1–200 de caractere (comparație explicită pe coloană: un șir gol sau prea lung nu trece).
ALTER TABLE "admin_notification" ADD COLUMN "context" TEXT;

ALTER TABLE "admin_notification" ADD CONSTRAINT "admin_notification_context_check"
    CHECK ("context" IS NULL OR (char_length("context") >= 1 AND char_length("context") <= 200));
