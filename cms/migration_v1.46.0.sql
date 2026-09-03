-- ============================================================
-- MIGRATION v1.46.0 — Remove documents from the archive; portfolio
-- summary no longer persists a document; monthly report/certificate
-- emails; duplicate-generation guard on the template form
--
-- This migration only covers the one change here that touches the
-- database — everything else in this version (removing the stray
-- documentsAPI.generate() call on the Portfolio page, attaching a
-- PDF + brief summary to monthly report emails, and the new
-- Preview-before-Generate step on the document template form) is
-- code-only, no schema change.
--
-- Requested directly: "i cannot remove documents from the archive
-- once i have put them there which i should be able to do."
-- archiveDocument (v1.23.0-era) was always a one-way DRAFT/FINAL ->
-- ARCHIVED move with no counterpart — this adds the missing "take it
-- back out" action (deleteDocument, documentsController.js), scoped
-- to already-ARCHIVED documents only.
--
-- This is a SOFT removal — the documents row is never actually
-- deleted. A real DELETE FROM documents would either be blocked
-- outright (grants/grant_conditions/loans_received/loans_given/
-- staff_document_grants/audit_engagement_documents/report_log all
-- hold real, un-cascaded foreign keys into documents.id) or silently
-- orphan document_signatures/document_stamps_applied history (those
-- link to documents via a polymorphic target_type/target_id pair,
-- not an enforced FK, so a hard delete wouldn't even error — it
-- would just quietly corrupt the audit trail of who signed/stamped a
-- document that no longer exists). Widening the status CHECK to add
-- DELETED and excluding it from every list view (same as the
-- existing SUPERSEDED exclusion in getAllDocuments) gets the same
-- practical result with none of that risk.
-- ============================================================

BEGIN;

-- 1) Widen documents.status to add 'DELETED'. Postgres CHECK
--    constraints can't be altered in place — drop and re-add with the
--    widened list, same pattern as every other CHECK-widening
--    migration in this repo (e.g. migration_v1.44.0.sql).
DO $$
DECLARE
    conname text;
BEGIN
    SELECT c.conname INTO conname
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'documents'
    AND    c.contype = 'c'
    AND    pg_get_constraintdef(c.oid) LIKE '%status%'
    AND    pg_get_constraintdef(c.oid) LIKE '%ARCHIVED%';

    IF conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', conname);
    END IF;

    ALTER TABLE documents
        ADD CONSTRAINT documents_status_check
        CHECK (status IN ('DRAFT','FINAL','ARCHIVED','SUPERSEDED','DELETED'));
EXCEPTION
    WHEN duplicate_object THEN
        -- Already widened by a previous run of this migration — fine.
        NULL;
END $$;

-- 2) New DOCUMENT_DELETE permission — like every permission in this
--    system, NOT auto-granted to any role (including Admin); an Admin
--    must grant it explicitly via Settings -> Roles -> Permissions
--    after this migration runs, same as every prior permission
--    addition.
INSERT INTO permissions (code, module, description)
VALUES ('DOCUMENT_DELETE', 'DOCUMENTS', 'Permanently remove an archived document from the archive')
ON CONFLICT (code) DO NOTHING;

COMMIT;
