-- ============================================================
-- MIGRATION v1.88.0 — meetings corrected after the event and who
-- signs them; email controls; financial statements pack with notes
--
-- Requested directly (13 Nov 2026):
--   "In the meeting and resolutions I would like that i am able to record
--    and edit the meetings despite the fact that the meeting was in past
--    and also be able to appoint proxies and signature staff."
--   "I would also like I can regulate the notification emails rather than
--    the system always sending emails ever time"
--   "now i would like to finish the financial statements and books and i
--    would like to them be downlaodable with the notes"
-- Confirmed: signature staff = who signs each meeting's minutes and
-- resolutions; emails = Admin rules per kind + each member's own choices
-- (legal notices and security emails always go); the pack has the
-- Statement of Changes in Equity, notes, a comparative year with current /
-- non-current, a directors' report and approval page; PDF and Excel.
--
-- What this adds:
--   1. meeting_amendments — every correction of a CLOSED meeting: who,
--      when, why (required) and what changed.
--   2. company_meetings.signatories — who signs the minutes, resolutions,
--      register, notice and certified copies of that meeting.
--   3. email_settings / email_kind_settings / user_email_preferences /
--      email_digest_queue — which emails go out, and to whom.
--   4. fs_pack_settings / fs_notes / fs_approvals — the financial
--      statements pack: non-current accounts, the wording of the notes and
--      of the directors' report per year, and the directors' approvals.
--   5. signature_ink_done — signature images already turned blue.
--   6. documents.record_section — groups of documents on an investment.
--
-- Nothing already recorded changes. Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Corrections of closed meetings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_amendments (
    id          SERIAL PRIMARY KEY,
    meeting_id  INTEGER NOT NULL REFERENCES company_meetings(id) ON DELETE CASCADE,
    changed_by  INTEGER REFERENCES users(id),
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason      TEXT NOT NULL,
    what        VARCHAR(200) NOT NULL,
    details     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_meeting_amendments_meeting ON meeting_amendments (meeting_id, changed_at DESC);
COMMENT ON TABLE meeting_amendments IS
    'v1.88.0 — a correction made to a meeting after it was closed (details, register, proxies, resolutions, votes), with the reason. Documents already generated are not changed; they are generated again.';

-- ------------------------------------------------------------
-- 2. Who signs a meeting's documents
-- ------------------------------------------------------------
ALTER TABLE company_meetings ADD COLUMN IF NOT EXISTS signatories JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN company_meetings.signatories IS
    'v1.88.0 — { MINUTES_CHAIR, MINUTES_SECRETARY, RESOLUTIONS_CHAIR, RESOLUTIONS_SECRETARY, REGISTER_CHAIR, REGISTER_SECRETARY, NOTICE_SECRETARY, CERTIFYING_DIRECTOR, CERTIFIED_SECRETARY: user id }. Missing = the meeting''s chairperson / secretary.';

-- ------------------------------------------------------------
-- 3. Email controls
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_settings (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    essential_only  BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE: only meeting notices and security emails
    digest_hour     INTEGER NOT NULL DEFAULT 18 CHECK (digest_hour BETWEEN 0 AND 23), -- Kampala time
    updated_by      INTEGER REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO email_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS email_kind_settings (
    kind                VARCHAR(40) PRIMARY KEY,
    mode                VARCHAR(10) NOT NULL DEFAULT 'INSTANT' CHECK (mode IN ('INSTANT', 'DIGEST', 'OFF')),
    members_may_change  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by          INTEGER REFERENCES users(id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_email_preferences (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        VARCHAR(40) NOT NULL,
    mode        VARCHAR(10) NOT NULL CHECK (mode IN ('INSTANT', 'DIGEST', 'OFF')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS email_digest_queue (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             VARCHAR(40) NOT NULL,
    notification_id  INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
    subject          VARCHAR(300),
    title            VARCHAR(300) NOT NULL,
    body             TEXT,
    link             VARCHAR(500),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_digest_unsent ON email_digest_queue (user_id) WHERE sent_at IS NULL;
COMMENT ON TABLE email_digest_queue IS
    'v1.88.0 — emails held for a person''s daily summary (sent at email_settings.digest_hour, Kampala).';

-- ------------------------------------------------------------
-- 4. Financial statements pack — wording of the notes, settings and
--    the directors' approval
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fs_pack_settings (
    id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- { "1400": "NON_CURRENT", "2000": "NON_CURRENT", ... } — GL codes not
    -- listed are current. Defaults are applied by the system.
    classification       JSONB NOT NULL DEFAULT '{}'::jsonb,
    auditors             TEXT,
    bankers              TEXT,
    lawyers              TEXT,
    approvals_required   INTEGER NOT NULL DEFAULT 2 CHECK (approvals_required BETWEEN 1 AND 10),
    updated_by           INTEGER REFERENCES users(id),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO fs_pack_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE fs_pack_settings IS
    'v1.88.0 — financial statements pack: which balance-sheet accounts are non-current, the auditors / bankers / lawyers named on the company information page, and how many directors must approve.';

CREATE TABLE IF NOT EXISTS fs_notes (
    fy_end_year  INTEGER PRIMARY KEY,            -- the financial year ending in this year (e.g. 2026 = 1 Jul 2025 – 30 Jun 2026)
    texts        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { section key: wording } — missing = the standard wording
    updated_by   INTEGER REFERENCES users(id),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE fs_notes IS
    'v1.88.0 — the wording of the directors'' report, accounting policies and notes for one financial year. Figures are never stored here; they always come from the books.';

CREATE TABLE IF NOT EXISTS fs_approvals (
    id                       SERIAL PRIMARY KEY,
    fy_end_year              INTEGER NOT NULL,
    user_id                  INTEGER NOT NULL REFERENCES users(id),
    approved_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signature_snapshot_path  TEXT,
    figures                  JSONB NOT NULL DEFAULT '{}'::jsonb,  -- key totals at the moment of approval
    withdrawn_at             TIMESTAMPTZ,
    withdrawn_by             INTEGER REFERENCES users(id),
    withdrawn_reason         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fs_approvals_active ON fs_approvals (fy_end_year, user_id) WHERE withdrawn_at IS NULL;
COMMENT ON TABLE fs_approvals IS
    'v1.88.0 — a director''s approval of one year''s financial statements, with their signature as it was then and the key totals approved. If the books later change, the pack says so.';

-- ------------------------------------------------------------
-- 5. Blue signatures — the stored signature images already turned blue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signature_ink_done (
    key           VARCHAR(500) PRIMARY KEY,
    converted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE signature_ink_done IS
    'v1.88.0 — signature images (signatures/, signature-snapshots/) already turned to blue ink, so each is converted only once.';

-- ------------------------------------------------------------
-- 6. Documents on an investment page, in groups
-- ------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS record_section VARCHAR(20);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'documents'::regclass AND conname = 'documents_record_section_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_record_section_check CHECK (record_section IS NULL OR record_section IN
            ('BUYING', 'RUNNING', 'MAINTENANCE', 'TAX', 'RETURNS', 'LEGAL', 'PLANNING', 'OTHER'));
    END IF;
END $$;
COMMENT ON COLUMN documents.record_section IS
    'v1.88.0 — the group a document uploaded on an investment page belongs to: buying & expanding, running costs, maintenance, taxes, returns & income, agreements/titles/certificates, proposals & reports, other. Empty = worked out from the document type.';

COMMIT;
