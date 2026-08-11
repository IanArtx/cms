-- ============================================================
-- MIGRATION v1.24.0 — COMPANY STAMPS & SEALS
--
-- Admin-uploaded named stamp images (Treasury, Secretariat, or any
-- other department the company wants) that get auto-attached to a
-- document once it is FULLY approved/signed — never to a draft.
--
-- Two new tables:
--
-- 1. company_stamps — one row per uploaded stamp image (PNG or
--    transparent-background SVG), stored on disk the same way the
--    company logo / member signatures are (uploads/stamps/...,
--    referenced in the DB as a /uploads/... URL path). Admin can
--    deactivate a stamp (soft, never hard-deleted, same convention
--    as roles.is_active / signature_requirements.is_active) without
--    breaking already-stamped documents, since those keep their own
--    record in document_stamps_applied (below) regardless.
--
-- 2. document_stamp_requirements — which stamp(s) apply to which
--    document_type, Admin-configured (Settings -> Stamps), same
--    is_active-toggle shape as signature_requirements. A document
--    type with zero active rows here never gets a stamp — opt-in per
--    type, exactly like the v1.23.0 signature requirements. The one
--    business rule from the request that needs its own enforcement —
--    "the monthly share certificate only gets a treasury stamp" — is
--    NOT hardcoded by stamp name; it's enforced structurally by a
--    partial unique index that allows SHARE_CERTIFICATE at most ONE
--    active stamp requirement at a time, whichever stamp the Admin
--    has assigned to that slot (named "Treasury" or anything else).
--
-- A third table, document_stamps_applied, snapshots exactly which
-- stamp(s) actually got baked onto a specific document or
-- certificate round at the moment it became fully approved/signed —
-- the same "what happened stays what happened" principle as
-- document_signatures.signature_snapshot_path, so a later change to
-- document_stamp_requirements never retroactively alters something
-- already finalised. Reuses the same target_type/target_id
-- polymorphic-target shape as document_signatures (a document or a
-- certificate signing round).
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. company_stamps — uploaded stamp/seal images. mime_type is
--    restricted to the two transparent-friendly formats requested
--    (PNG, SVG) so a stamp always overlays cleanly onto a document
--    without a white/coloured box around it.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_stamps (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    file_path   TEXT NOT NULL,
    mime_type   VARCHAR(50) NOT NULL CHECK (mime_type IN ('image/png', 'image/svg+xml')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  INTEGER REFERENCES users(id)
);

-- ----------------------------------------------------------
-- 2. document_stamp_requirements — which stamp(s) get applied to
--    which document_type once it is fully approved/signed. Uses the
--    full documents.document_type CHECK list (not just the signable
--    subset) since the request describes stamping "the important
--    documents as specified by the company" generally, plus
--    SHARE_CERTIFICATE for the monthly certificate rule.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_stamp_requirements (
    id            SERIAL PRIMARY KEY,
    document_type VARCHAR(30) NOT NULL
                  CHECK (document_type IN (
                      'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
                      'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
                      'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT',
                      'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER', 'SHARE_CERTIFICATE'
                  )),
    stamp_id      INTEGER NOT NULL REFERENCES company_stamps(id),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by    INTEGER REFERENCES users(id),
    UNIQUE (document_type, stamp_id)
);

-- Structural enforcement of "monthly share certificates only get a
-- treasury stamp": SHARE_CERTIFICATE may have at most ONE active
-- stamp requirement row at any time, whichever stamp the Admin has
-- placed there. Every other document_type may have several active
-- stamps at once (e.g. a Resolution could carry both a Secretariat
-- and a Director's seal).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_stamp_per_share_cert
    ON document_stamp_requirements (document_type)
    WHERE document_type = 'SHARE_CERTIFICATE' AND is_active = TRUE;

-- ----------------------------------------------------------
-- 3. document_stamps_applied — snapshot of which stamp(s) were
--    actually baked onto a specific document/round the moment it
--    became fully approved/signed. target_type/target_id mirrors
--    document_signatures' polymorphic target (a `documents` row or a
--    `certificate_signing_rounds` row).
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_stamps_applied (
    id          SERIAL PRIMARY KEY,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('DOCUMENT', 'CERTIFICATE_ROUND')),
    target_id   INTEGER NOT NULL,
    stamp_id    INTEGER NOT NULL REFERENCES company_stamps(id),
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (target_type, target_id, stamp_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_stamps_applied_target ON document_stamps_applied (target_type, target_id);

COMMIT;

-- ============================================================
-- After running this migration:
--   1. Restart the backend so the new stamp upload/config endpoints
--      and the apply-on-approval hooks are picked up.
--   2. An Admin uploads stamp images in Settings -> Stamps (PNG or
--      transparent SVG) — nothing is stamped anywhere until this is
--      done.
--   3. An Admin assigns which stamp(s) apply to which document type
--      in the same screen. Nothing is stamped on any document type
--      until it has at least one active row in
--      document_stamp_requirements — fully opt-in, exactly like
--      v1.23.0's signature_requirements.
--   4. SHARE_CERTIFICATE can only ever have one active stamp
--      assigned at a time (enforced by the database itself) — assign
--      whichever stamp represents "Treasury" to that slot.
--   5. Nothing here changes already-finalised documents retroactively
--      — document_stamps_applied only ever gets a new row going
--      forward, at the moment something newly becomes fully signed.
-- ============================================================
