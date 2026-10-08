-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actorId_fkey";

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "actorLabel" TEXT;

-- Jurnal DOAR DE ADĂUGARE: orice UPDATE, DELETE sau TRUNCATE este respins de baza de date.
CREATE FUNCTION audit_log_reject_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log este doar de adaugare: % interzis', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_changes();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_changes();
