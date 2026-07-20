-- ============================================================
-- MIGRATION v1.15.0 — DOCUMENTS: PREVIEW + DOWNLOAD
--
-- Fixes a gap where documents could only ever be seen as a list —
-- there was no way to preview or download an uploaded file, and
-- worse, a SYSTEM_GENERATED document (meeting agenda/minutes) had NO
-- way to be reconstructed after the moment it was first generated,
-- because the values used to fill it in were never saved anywhere.
--
-- 1. New documents.template_data (JSONB) column — persists the
--    filled-in values for a SYSTEM_GENERATED document so it can be
--    re-rendered on demand (frontend reuses the exact same template
--    function it used at generation time).
-- 2. New GET /api/documents/:id/download endpoint:
--      - UPLOADED documents: streams the real file from disk.
--      - SYSTEM_GENERATED documents: returns { document_type,
--        template_data, title } as JSON; the frontend re-renders it
--        client-side and either shows it (Preview) or triggers the
--        browser print-to-PDF dialog (Download), exactly like the
--        existing print/export flows used elsewhere in the app.
--    This is a code-only addition alongside this migration
--    (documentsController.js / routes/documents.js) — listed here
--    for the version record.
--
-- IMPORTANT: any document generated BEFORE this migration has no
-- template_data on file (it was never captured) — those older
-- records will show "cannot be regenerated for preview/download".
-- Uploaded documents are unaffected; their real files were always on
-- disk and this migration makes no change to how they're stored.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS template_data JSONB;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. Every document row in Documents now has a "View" and
--      "Download" action. Uploaded files stream directly; generated
--      documents (meeting agenda/minutes) re-render from their saved
--      field values, same as right after you generated them.
--   3. Documents generated before this migration cannot be
--      regenerated (their fill-in values were never saved) — this
--      is a data limitation, not a bug in the new feature.
-- ------------------------------------------------------------
