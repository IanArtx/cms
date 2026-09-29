-- ============================================================
-- MIGRATION v1.67.0 — Personal documents (owner_user_id) so Share
-- Purchase Receipts only ever show to their own shareholder and to
-- Treasury, never in the shared "All Documents" list.
--
-- Requested directly: "currently the share reciepts aren't going to
-- their designated location in document arrangements where
-- personalised should go to my documents only visible to that
-- particular person and to the treasury where they can see all
-- receipts grouped by month".
--
-- v1.65.0 filed each receipt as an ordinary `documents` row, which
-- meant it ALSO appeared in "All Documents" for anyone holding
-- DOCUMENT_VIEW (Secretary, Directors, ...), and ownership was only
-- ever inferred at read time through a join to
-- shareholder_contributions. This makes ownership explicit on the
-- document itself:
--
-- 1. documents.owner_user_id — the ONE member a personal document
--    belongs to. NULL for every ordinary company document (unchanged
--    behaviour). A document with an owner:
--      - never appears in GET /documents ("All Documents"),
--      - appears in GET /documents/mine for its owner only,
--      - appears in GET /documents/share-receipts for Treasury
--        (Treasurer / Assistant Treasurer / Admin),
--      - can only be opened (GET /:id, /:id/download) by its owner or
--        Treasury.
--
-- 2. Backfill: every existing Share Purchase Receipt gets its owner
--    from the contribution it was issued for.
--
-- The receipts' currency fix (price per share shown in the share
-- price's own currency, UGX, with the contribution converted at the
-- rate used for the share calculation) is data inside template_data,
-- rebuilt for existing receipts by backfill_v1.67.0_share_receipts.js.
--
-- Idempotent. Apply to BOTH databases:
--   node run_migration.js migration_v1.67.0.sql
-- ============================================================

BEGIN;

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_documents_owner_user
    ON documents (owner_user_id)
    WHERE owner_user_id IS NOT NULL;

UPDATE documents d
SET    owner_user_id = sc.user_id
FROM   shareholder_contributions sc
WHERE  d.related_record_type = 'shareholder_contributions'
AND    d.related_record_id = sc.id
AND    d.template_data ->> 'receipt_kind' = 'SHARE_PURCHASE'
AND    d.owner_user_id IS DISTINCT FROM sc.user_id;

COMMIT;
