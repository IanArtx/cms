-- ============================================================
-- MIGRATION v1.18.0 — RECEIPT + BOARD RESOLUTION DOCUMENTS
--
-- Finishes off two document types that were already half-wired:
-- 'RECEIPT' was already a valid document_type/template_type in the
-- database and API, but had no frontend template to actually render
-- one, and no seeded document_templates row to make it selectable in
-- Generate Document > Step 1. 'RESOLUTION' (for Board/Directors
-- resolutions) didn't exist anywhere at all.
--
-- 1. Widens the two CHECK constraints (document_templates.template_type,
--    documents.document_type) to add 'RESOLUTION' alongside the
--    existing 'RECEIPT'.
-- 2. Seeds a document_templates row for each, so both appear in
--    Generate Document > Step 1 immediately — no Admin setup needed.
-- 3. Code-only additions alongside this migration (no further DB
--    change): receiptTemplate()/resolutionTemplate() in
--    cms-frontend/src/utils/exportUtils.js, RECEIPT/RESOLUTION
--    entries in GenerateDocumentPage.jsx's TEMPLATE_FIELDS, and
--    matching entries in DocumentsPage.jsx's GENERATED_RENDERERS
--    (needed so previously-generated receipts/resolutions can still
--    be previewed/downloaded later, not just right after creating
--    them) — listed here for the version record.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'document_templates'::regclass
        AND pg_get_constraintdef(oid) LIKE '%RESOLUTION%'
    ) THEN
        ALTER TABLE document_templates DROP CONSTRAINT IF EXISTS document_templates_template_type_check;
        ALTER TABLE document_templates
            ADD CONSTRAINT document_templates_template_type_check
            CHECK (template_type IN (
                'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
                'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL',
                'RECEIPT','RESOLUTION','CONTRACT','LOAN_AGREEMENT','GRANT_AGREEMENT','OTHER'
            ));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'documents'::regclass
        AND pg_get_constraintdef(oid) LIKE '%RESOLUTION%'
    ) THEN
        ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
        ALTER TABLE documents
            ADD CONSTRAINT documents_document_type_check
            CHECK (document_type IN (
                'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
                'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL',
                'RECEIPT','RESOLUTION','CONTRACT','LOAN_AGREEMENT','GRANT_AGREEMENT','OTHER'
            ));
    END IF;
END $$;

INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Receipt', 'RECEIPT',
       'A general-purpose receipt for money received in person (cash, cheque, mobile money, etc).',
       'Rendered client-side — see receiptTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'RECEIPT'
);

INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Board Resolution', 'RESOLUTION',
       'A formal resolution passed by the Board/Directors, with proposer, seconder, and vote outcome.',
       'Rendered client-side — see resolutionTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'RESOLUTION'
);

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. Documents > Generate Document > Step 1 now shows "Receipt"
--      and "Board Resolution" as selectable templates alongside
--      Meeting Agenda/Minutes.
--   3. If you'd previously created your own custom RECEIPT template
--      row by hand (via Documents > Templates), this migration
--      leaves it alone — the NOT EXISTS guard only inserts if no
--      RECEIPT/RESOLUTION row exists yet at all.
-- ------------------------------------------------------------
