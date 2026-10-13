-- `failed` = acțiunea a fost autorizată, dar a eșuat din cauza unei defecțiuni (ex. storage indisponibil).
-- Diferă de `denied` (încercare refuzată): rapoartele de securitate nu trebuie amestecate cu defecțiunile.
-- ALTER TABLE ... CONSTRAINT nu declanșează triggerele de UPDATE/DELETE (jurnalul rămâne doar de adăugare).
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_outcome_check";
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_outcome_check" CHECK ("outcome" IN ('success', 'denied', 'failed'));
