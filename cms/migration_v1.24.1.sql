-- ============================================================
-- MIGRATION v1.24.1 — COMPANY-WIDE STAMPS ON/OFF SWITCH
--
-- Adds a single master toggle, `company_settings.stamps_enabled`,
-- so an Admin can turn the whole company-stamps-&-seals feature
-- (v1.24.0) on or off from Settings without touching any of the
-- per-document-type configuration underneath it.
--
-- Defaults to FALSE (off) — the feature was just built and nothing
-- has been configured yet (no stamps uploaded, no document types
-- assigned), so it stays inert until an Admin deliberately switches
-- it on, even on a database that already ran migration_v1.24.0.sql.
--
-- This does NOT touch document_stamp_requirements or company_stamps
-- — an Admin can still upload stamps and assign them to document
-- types while the switch is off; nothing is actually applied to a
-- real document/certificate until it's turned on. Turning it off
-- later does not remove stamps already baked onto documents that
-- were finalised while it was on (document_stamps_applied rows are
-- never touched by this switch).
--
-- Safe to run on a database that already has this column (idempotent).
-- ============================================================

BEGIN;

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS stamps_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

-- ============================================================
-- After running this migration:
--   1. Restart the backend so the new /settings/company field and
--      the stampService gate are picked up.
--   2. Company stamps stay OFF by default even if stamps were
--      already uploaded/configured before this migration — an Admin
--      must explicitly switch it on in Settings -> Stamps.
--   3. Once switched on, behaviour is exactly what v1.24.0 already
--      documented — opt-in per document type, Share Certificates
--      capped at one active stamp.
-- ============================================================
