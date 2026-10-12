-- Rezultatul acțiunii înregistrate: reușită sau refuzată (încercare fără permisiune).
-- Rândurile existente sunt reușite. ALTER TABLE ... ADD COLUMN nu declanșează triggerele de
-- UPDATE/DELETE (jurnalul rămâne doar de adăugare).
ALTER TABLE "audit_log" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'success';

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_outcome_check" CHECK ("outcome" IN ('success', 'denied'));
