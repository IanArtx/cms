-- ============================================================
-- MIGRATION v1.34.0 -- MEMBER PORTFOLIO SUMMARY DOCUMENT
--
-- Seeds a document_templates row for FINANCIAL_REPORT_INDIVIDUAL --
-- this template_type/document_type was ALREADY allowed by both CHECK
-- constraints since the schema was first written (it was designed for
-- but never finished), so unlike migration_v1.18.0.sql (RECEIPT/
-- RESOLUTION) no ALTER TABLE is needed here at all -- this migration
-- is just the one seed INSERT.
--
-- What this unlocks: the new "Generate Portfolio Summary" button on
-- each member's Portfolio page (Section 6.x, CMS_BIBLE.md) saves a
-- real, audit-logged Document (source SYSTEM_GENERATED) the same way
-- Receipts/Resolutions do -- downloadable and re-printable later from
-- the Documents module, not just a one-off browser print.
--
-- Code-only additions alongside this migration (no further DB
-- change): memberPortfolioTemplate() in
-- cms-frontend/src/utils/exportUtils.js, a matching entry in
-- DocumentsPage.jsx's GENERATED_RENDERERS (so a previously-generated
-- portfolio summary can still be reopened later, same as every other
-- generated document type) -- listed here for the version record.
--
-- Safe to run more than once -- the INSERT only fires if no
-- FINANCIAL_REPORT_INDIVIDUAL row exists yet at all.
-- ============================================================

BEGIN;

INSERT INTO document_templates (name, template_type, description, template_body)
SELECT 'Member Portfolio Summary', 'FINANCIAL_REPORT_INDIVIDUAL',
       'A full snapshot of one member''s standing in the company -- shareholding, contributions, savings, dividends received, side fund standing, and transaction history. Generated from the member''s own Portfolio page.',
       'Rendered client-side -- see memberPortfolioTemplate() in exportUtils.js.'
WHERE NOT EXISTS (
    SELECT 1 FROM document_templates WHERE template_type = 'FINANCIAL_REPORT_INDIVIDUAL'
);

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. Every member's Portfolio page gets a working "Generate
--      Portfolio Summary" button -- it was already visible before
--      this migration, but would have failed with "Document template
--      not found" until this seed row existed.
--   3. If you'd previously created your own custom
--      FINANCIAL_REPORT_INDIVIDUAL template row by hand, this
--      migration leaves it alone -- the NOT EXISTS guard only inserts
--      if no row exists yet at all.
-- ------------------------------------------------------------
