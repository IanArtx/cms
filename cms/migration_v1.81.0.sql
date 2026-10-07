-- ============================================================
-- MIGRATION v1.81.0 — Documents by category, back out of the archive,
-- unfinished forms kept (drafts), each shareholder's shares registered
-- with URSB, and repairs.
--
-- Requested directly:
--   "the documents page is organised and documents are arranged under
--    tiles that match their categories therefore having a dedicated
--    page for each category"
--   "documents in archives can be removed and put among the regular
--    documents"
--   "as one fills the forms / templates that the system can recall
--    where they left off … sudden refresh, loss of internet … the back
--    button or click a button in the UI unintentionally"
--   "the system … is constantly crashing … in the meetings and
--    resolutions page"
--   "the react app logo shows as the icon when one installs the system
--    link on their mobile homescreen … instead of the company logo"
--   "the registered shares for each shareholder can be recorded and the
--    excess also tracked in individual portfolio and generally by the
--    administration and treasury"
-- Confirmed: registered shares entered once from the URSB register, then
-- filed allotment returns add to them; drafts kept on the server and on
-- the device; an archived document goes back to what it was before;
-- every top-level document category gets a tile.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Repair: the "file this special resolution with URSB" notification
--    linked to /meetings/resolutions (no number), which crashed the
--    meeting page. Point every such notification at its resolution.
-- ------------------------------------------------------------
UPDATE notifications
SET    link = '/meetings/resolutions/' || related_record_id
WHERE  link = '/meetings/resolutions'
AND    related_record_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Documents: archive type, what a document was before it was
--    archived, and taking it back out of the archive.
-- ------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archive_type         VARCHAR(30);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_from_status VARCHAR(30);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at          TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_by          INTEGER REFERENCES users(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unarchived_at        TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unarchived_by        INTEGER REFERENCES users(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unarchive_reason     TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_archive_type_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_archive_type_check CHECK (archive_type IS NULL OR archive_type IN
            ('REGISTRATION', 'TAX_FILING', 'MOU', 'ACT', 'LICENSE', 'COMPLIANCE', 'LEGAL', 'OTHER'));
    END IF;
END $$;

-- Documents archived before this update: what they were is not recorded,
-- so take it from whether they had been approved / fully signed.
UPDATE documents
SET    archived_from_status = CASE WHEN approved_at IS NOT NULL OR fully_signed THEN 'FINAL' ELSE 'DRAFT' END
WHERE  status = 'ARCHIVED' AND archived_from_status IS NULL;

-- Their archive type was never saved (the upload form's choice was lost).
UPDATE documents
SET    archive_type = 'OTHER'
WHERE  archive_type IS NULL
AND    (status = 'ARCHIVED' OR related_record_type = 'COMPANY_ARCHIVE');

CREATE INDEX IF NOT EXISTS idx_documents_category ON documents (category_id);

-- ------------------------------------------------------------
-- 3. Unfinished forms (drafts), one row per person and form.
--    Only the person themselves can read their drafts. A draft never
--    posts or approves anything — it only refills a form.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS form_drafts (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    draft_key   VARCHAR(160) NOT NULL,
    title       VARCHAR(200),
    page_path   VARCHAR(300),
    data        JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT form_drafts_user_key_unique UNIQUE (user_id, draft_key)
);
CREATE INDEX IF NOT EXISTS idx_form_drafts_user ON form_drafts (user_id, updated_at DESC);

-- ------------------------------------------------------------
-- 4. Each shareholder's shares registered with URSB.
--    The figure from the URSB register, as at a date; later allotments
--    whose return of allotment is filed are added by the system. One
--    current row per member; a correction keeps the old row as history.
--    These are records of what URSB holds — they never change anyone's
--    shares, money or the books.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_registered_shares (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER      NOT NULL REFERENCES users(id),
    shares         INTEGER      NOT NULL CHECK (shares >= 0),
    as_at          DATE         NOT NULL,
    note           VARCHAR(300),
    document_id    INTEGER      REFERENCES documents(id),
    change_reason  TEXT,
    recorded_by    INTEGER      REFERENCES users(id),
    recorded_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    superseded_at  TIMESTAMPTZ,
    superseded_by  INTEGER      REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS member_registered_shares_current
    ON member_registered_shares (user_id) WHERE superseded_at IS NULL;

COMMIT;
